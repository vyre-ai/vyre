// The real session stream for the chat screen: core/stream's resumable client over the box's
// ticketed WebSocket, plus the writes the screen makes (send, stop, answer, edit and retry, retry,
// branch). Every write goes through the app's outbox with an Idempotency-Key (src/api/box send),
// so a retry never sends twice.
//
// One code path for both ways of reaching the box: `stream.open` is an ordinary tool call, and the
// socket comes from the box layer's `socket(path)`, which is a direct WebSocket on the LAN or
// tailnet and a socket carried over the relay channel on the relay. Each attempt asks for a fresh
// one-use ticket from the client's own cursor, so a resume is the same call on either path.

import { connect as connectStream, wsDuplex } from "@vyre/stream/client.js";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { call, send, socket } from "../api/box";
import { peerDuplex, peerWanted } from "../real/peer";
import { SURFACE } from "../state/live";
import { streamSource } from "./stream-source.js";
import { reason } from "./reason.js";
import { replyInput } from "./reply.js";
import { viewerZone } from "../time/show.js";
import type { StreamSource } from "./mock-stream";

type Done = Promise<{ ok: true; thread?: string } | { ok: false; reason: string }>;

/** What the screen can do to a session beyond the mock's send, stop and answer. */
export type SessionActions = {
  /** Go back to before `message`, then send `text` in its place. */
  editRetry(message: string, text: string): Done;
  /** Go back to before `message` and send the same words again. */
  retry(message: string): Done;
  /** A new session with the conversation up to (not including) `at`; resolves with its id. */
  branch(at: string): Done;
  /** Send a message; resolves with why it was refused, or null. */
  sendText(text: string, o?: { mentions?: Mention[]; mode?: "steer" | "queue" }): Promise<string | null>;
  /** Tell the chat this person is typing (shown to the others for a few seconds; nothing is kept). */
  typing(): void;
  stopSession(): Promise<string | null>;
  answerAsk(ask: string, decision: "approve" | "deny"): Promise<string | null>;
};
/** What the screen can do in a group chat (a session with several people and assistants): every call is a server tool through the outbox. The StreamSource methods (sendGroup, keep, react, pin, markRead) fire and forget; these return what the box answered. */
export type GroupActions = {
  /** One message to several assistants at once (a fan-out set), or to whoever routing picks when `to` is empty. Resolves with the answer message ids and the fan-out group id. */
  sendGroupText(text: string, opts?: { to?: string[]; mentions?: string[]; message?: string; replyTo?: string; mode?: "steer" | "queue" }): Promise<{ ok: true; message: string; group?: string; answers: { who: string; message: string }[] } | { ok: false; reason: string }>;
  keepAnswer(group: string, message: string): Promise<string | null>;
  reactTo(message: string, emoji: string, on?: boolean): Promise<string | null>;
  pinMessage(message: string, on?: boolean): Promise<string | null>;
  /** Move this person's read marker forward; their other open connections hear it. */
  markReadTo(upto: number): Promise<string | null>;
};
/** A # tag picked in the composer. */
export type Mention = { kind: string; id: string; name: string };
export type BoxStream = StreamSource & SessionActions & GroupActions;

async function write(tool: string, input: Record<string, unknown>) {
  const { answered } = await send<Record<string, unknown>>(tool, input);
  return answered;
}

export function boxStream(session: string): BoxStream {
  let viewer: string | undefined;
  let head = 0;
  const source = streamSource({
    connect: connectStream,
    open: async ({ from }) => {
      // A device paired to its server over the relay has no WebSocket to it: the stream rides the peer wire (stream.follow), resumed by `from` like any other.
      if (peerWanted()) {
        const d = await peerDuplex(session, from);
        if (typeof d.info.head === "number") head = d.info.head;
        if (d.info.viewer) viewer = d.info.viewer;
        return d;
      }
      const r = await call<{ path: string; viewer?: string; head?: number; session?: string }>("stream.open", { chat: session, from });
      if (r.error) throw new Error(reason(r.error));
      if (typeof r.data.head === "number") head = r.data.head;
      if (r.data.viewer) viewer = r.data.viewer;
      const ws = await socket(r.data.path);
      // wsDuplex builds `new WS(url)`; a constructor that returns the socket already made adopts it.
      return wsDuplex(r.data.path, function Adopt() { return ws; } as unknown as typeof WebSocket);
    },
    // After a reset the folder starts clear; resume from the oldest frame the log still holds.
    snapshot: async () => {
      const r = await call<{ floor: number }>("stream.open", { chat: session });
      return { cur: r.data?.floor ?? 0 };
    },
  });

  const done = async (tool: string, input: Record<string, unknown>): Done => {
    const r = await write(tool, input);
    if (r.error) return { ok: false, reason: reason(r.error) };
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (d.unsupported || d.rewound === false || d.retried === false) return { ok: false, reason: String(d.note ?? "This session cannot go back here.") };
    const id = typeof d.id === "string" ? d.id : typeof d.thread === "string" ? d.thread : undefined;
    return { ok: true, thread: id };
  };
  // The per-run controls (edit, retry, branch) address the chat's run by its thread, which work.chat.get names in the chat's slots.
  const onRun = async (fn: (thread: string) => Done): Done => {
    const got = await call<{ slots?: { thread?: string }[] }>("work.chat.get", { chat: session });
    const thread = got.data?.slots?.find((x) => typeof x.thread === "string")?.thread;
    if (!thread) return { ok: false, reason: "This chat has not started yet." };
    return fn(thread);
  };
  const note = async (tool: string, input: Record<string, unknown>) => {
    const r = await write(tool, input);
    return r.error ? reason(r.error) : null;
  };

  return {
    ...source,
    viewer: () => viewer,
    head: () => head,
    // A # tag the person picked (a record, a vault item, a file) goes beside the words as { kind, id, name }: the box resolves it as the person, and a sealed part of a record reaches the assistant only as a placeholder.
    // Any chat takes a message through stream.send: the first one into a new chat starts its run (E3).
    sendText: (text, o) => note("stream.send", { chat: session, text, message: newUuid(), surface: SURFACE, tz: viewerZone(), ...(o?.mode ? { mode: o.mode } : {}), ...(o?.mentions?.length ? { mentions: o.mentions.slice(0, 8).map((m) => m.id) } : {}) }),
    stopSession: () => note("threads.chat-stop", { chat: session }),
    // The ask's own answer path (threads.answer): the same call the inbox swipe makes.
    answerAsk: (ask, decision) => note("threads.answer", { ask, decision: decision === "approve" ? "allow" : "deny", surface: SURFACE }),
    sendGroupText: async (text, opts = {}) => {
      const message = opts.message ?? newUuid();
      const r = await write("stream.send", { chat: session, text, message, surface: SURFACE, tz: viewerZone(), ...(opts.to?.length ? { to: opts.to } : {}), ...(opts.mode ? { mode: opts.mode } : {}), ...replyInput(opts.replyTo ? { message: opts.replyTo } : null), ...(opts.mentions?.length ? { mentions: opts.mentions } : {}) });
      if (r.error) return { ok: false, reason: reason(r.error) };
      const d = (r.data ?? {}) as { message?: string; group?: string; answers?: { who: string; message: string }[] };
      return { ok: true, message: d.message ?? message, ...(d.group ? { group: d.group } : {}), answers: d.answers ?? [] };
    },
    keepAnswer: (group, message) => note("stream.keep", { chat: session, group, keep: message }),
    reactTo: (message, emoji, on = true) => note("stream.react", { chat: session, message, emoji, on }),
    pinMessage: (message, on = true) => note("stream.pin", { chat: session, message, on }),
    markReadTo: (upto) => note("stream.mark-read", { chat: session, upto }),
    editRetry: (message, text) => onRun((thread) => done("threads.edit-retry", { thread, message, text, surface: SURFACE })),
    retry: (message) => onRun((thread) => done("threads.retry", { thread, message, surface: SURFACE })),
    branch: (at) => onRun((thread) => done("threads.branch", { thread, at, surface: SURFACE })),
    // StreamSource's own, for callers that hold only that shape: fire and forget.
    typing() { void write("stream.typing", { chat: session }); },
    send(text) { void this.sendText(text); },
    answer(ask, decision) { void this.answerAsk(ask, decision); },
    stop() { void this.stopSession(); },
    sendGroup(text, o) { void this.sendGroupText(text, { to: o.to }); },
    keep(group, message) { void this.keepAnswer(group, message); },
    react(message, emoji, remove) { void this.reactTo(message, emoji, !remove); },
    pin(message, pinned) { void this.pinMessage(message, pinned); },
    markRead(upto) { void this.markReadTo(upto); },
  };
}
