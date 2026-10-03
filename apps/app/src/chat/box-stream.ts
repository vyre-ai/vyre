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
import { SURFACE } from "../state/live";
import { streamSource } from "./stream-source.js";
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
  sendText(text: string): Promise<string | null>;
  stopSession(): Promise<string | null>;
  answerAsk(ask: string, decision: "approve" | "deny"): Promise<string | null>;
};
/** What the screen can do in a group chat (a session with several people and assistants): every call is a server tool through the outbox. The StreamSource methods (sendGroup, keep, react, pin, markRead) fire and forget; these return what the box answered. */
export type GroupActions = {
  /** One message to several assistants at once (a fan-out set), or to whoever routing picks when `to` is empty. Resolves with the answer message ids and the fan-out group id. */
  sendGroupText(text: string, opts?: { to?: string[]; mentions?: string[]; message?: string }): Promise<{ ok: true; message: string; group?: string; answers: { who: string; message: string }[] } | { ok: false; reason: string }>;
  keepAnswer(group: string, message: string): Promise<string | null>;
  reactTo(message: string, emoji: string, on?: boolean): Promise<string | null>;
  pinMessage(message: string, on?: boolean): Promise<string | null>;
  /** Move this person's read marker forward; their other open connections hear it. */
  markReadTo(upto: number): Promise<string | null>;
};
export type BoxStream = StreamSource & SessionActions & GroupActions;

const reason = (e: { code?: string; message?: string }) => e.message || e.code || "Refused";

async function write(tool: string, input: Record<string, unknown>) {
  const { answered } = await send<Record<string, unknown>>(tool, input);
  return answered;
}

export function boxStream(session: string): BoxStream {
  const source = streamSource({
    connect: connectStream,
    open: async ({ from }) => {
      const r = await call<{ path: string }>("stream.open", { session, from });
      if (r.error) throw new Error(reason(r.error));
      const ws = await socket(r.data.path);
      // wsDuplex builds `new WS(url)`; a constructor that returns the socket already made adopts it.
      return wsDuplex(r.data.path, function Adopt() { return ws; } as unknown as typeof WebSocket);
    },
    // After a reset the folder starts clear; resume from the oldest frame the log still holds.
    snapshot: async () => {
      const r = await call<{ floor: number }>("stream.open", { session });
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
  const note = async (tool: string, input: Record<string, unknown>) => {
    const r = await write(tool, input);
    return r.error ? reason(r.error) : null;
  };

  return {
    ...source,
    sendText: (text) => note("threads.send", { thread: session, text, surface: SURFACE, uuid: newUuid() }),
    stopSession: () => note("threads.stop", { thread: session }),
    // The ask's own answer path (threads.answer): the same call the inbox swipe makes.
    answerAsk: (ask, decision) => note("threads.answer", { ask, decision: decision === "approve" ? "allow" : "deny", surface: SURFACE }),
    sendGroupText: async (text, opts = {}) => {
      const message = opts.message ?? newUuid();
      const r = await write("stream.send", { session, text, message, surface: SURFACE, ...(opts.to?.length ? { to: opts.to } : {}), ...(opts.mentions?.length ? { mentions: opts.mentions } : {}) });
      if (r.error) return { ok: false, reason: reason(r.error) };
      const d = (r.data ?? {}) as { message?: string; group?: string; answers?: { who: string; message: string }[] };
      return { ok: true, message: d.message ?? message, ...(d.group ? { group: d.group } : {}), answers: d.answers ?? [] };
    },
    keepAnswer: (group, message) => note("stream.keep", { session, group, keep: message }),
    reactTo: (message, emoji, on = true) => note("stream.react", { session, message, emoji, on }),
    pinMessage: (message, on = true) => note("stream.pin", { session, message, on }),
    markReadTo: (upto) => note("stream.mark-read", { session, upto }),
    editRetry: (message, text) => done("threads.edit-retry", { thread: session, message, text, surface: SURFACE }),
    retry: (message) => done("threads.retry", { thread: session, message, surface: SURFACE }),
    branch: (at) => done("threads.branch", { thread: session, at, surface: SURFACE }),
    // StreamSource's own, for callers that hold only that shape: fire and forget.
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
