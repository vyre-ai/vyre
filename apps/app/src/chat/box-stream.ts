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
import { showingJoined, teamCall, teamSession } from "../real/team-join";
import { tool } from "../real/box";
import { useSpaces } from "../../screens/shell/state";
import { liveDuplex } from "./member-live.js";
import { AppState, Platform } from "react-native";
import { SURFACE } from "../state/live";
import { streamSource } from "./stream-source.js";
import { reason } from "./reason.js";
import { replyInput } from "./reply.js";
import { viewerZone } from "../time/show.js";
import { routeComposerLine } from "../../../lib/thread-composer-route.js";
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
  sendText(text: string, o?: { message?: string; mentions?: Mention[]; mode?: "steer" | "queue"; attachments?: Attached[] }): Promise<string | null>;
  /** Tell the chat this person is typing (shown to the others for a few seconds; nothing is kept). */
  typing(): void;
  stopSession(): Promise<string | null>;
  answerAsk(ask: string, decision: "approve" | "deny"): Promise<string | null>;
};
/** What the screen can do in a group chat (a session with several people and assistants): every call is a server tool through the outbox. The StreamSource methods (sendGroup, keep, react, pin, markRead) fire and forget; these return what the box answered. */
export type GroupActions = {
  /** One message to several assistants at once (a fan-out set), or to whoever routing picks when `to` is empty. Resolves with the answer message ids and the fan-out group id. */
  sendGroupText(text: string, opts?: { to?: string[]; mentions?: string[]; account?: string; message?: string; replyTo?: string; mode?: "steer" | "queue"; attachments?: Attached[] }): Promise<{ ok: true; message: string; group?: string; answers: { who: string; message: string }[] } | { ok: false; reason: string }>;
  keepAnswer(group: string, message: string): Promise<string | null>;
  reactTo(message: string, emoji: string, on?: boolean): Promise<string | null>;
  pinMessage(message: string, on?: boolean): Promise<string | null>;
  /** Move this person's read marker forward; their other open connections hear it. */
  markReadTo(upto: number): Promise<string | null>;
};
/** A file added to the chat with attachments.put, named on the message that carries it. */
export type Attached = { id: string; name: string; mime: string; bytes: number };
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
  // A chat of a team this device JOINED (a joined team is showing and the team's door knows the chat): it is read live over the member door (`chat.open`, src/chat/member-live.js) and written through the door's
  // calls, never through her own home. Anything else, her own home's chats and the owner's, takes the paths below exactly as before.
  const teamSpace = async (): Promise<string | null> => {
    try {
      if (!(await showingJoined())) return null;
      const sp = useSpaces.getState().space;
      await tool("work.chat.get", { chat: session });
      return sp;
    } catch { return null; }
  };
  const seen = () => (Platform.OS === "web" ? typeof document === "undefined" || document.visibilityState !== "hidden" : AppState.currentState === "active");
  const writeVia = async (name: string, input: Record<string, unknown>) => {
    if (!(await teamSpace())) return write(name, input);
    try { return { data: await tool(name, input) } as { data?: unknown; error?: { code?: string; message?: string } }; }
    catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
  };
  const source = streamSource({
    connect: connectStream,
    open: async ({ from }) => {
      const team = await teamSpace();
      if (team) {
        const sess = await teamSession(team);
        try {
          const d = await liveDuplex({ openChat: (chat, from, h) => sess.openChat(chat, from, h), chat: session, from, onEnd: () => sess.close() });
          if (typeof d.info.head === "number") head = d.info.head;
          if (d.info.viewer) viewer = d.info.viewer;
          return d;
        } catch (e) { sess.close(); throw e; }
      }
      // A device paired to its server over the relay has no WebSocket to it: the stream rides the peer wire (stream.follow), resumed by `from` like any other.
      if (peerWanted()) {
        // with several servers paired, a chat is followed on the server that holds it, whatever is showing; one whose server is not known is refused, never guessed
        const { routeCall } = await import("../real/space-servers");
        const showing = (await import("../../screens/shell/state")).useSpaces.getState().space;
        const route = await routeCall({ input: { chat: session }, showing });
        if (route.error) throw new Error(route.error.message);
        const d = await peerDuplex(session, from, route.box);
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
      const team = await teamSpace();
      if (team) { const s = (await teamCall(team, "chat.read", [{ chat: session, limit: 0 }])) as { floor?: number }; return { cur: s.floor ?? 0 }; }
      const r = await call<{ floor: number }>("stream.open", { chat: session });
      return { cur: r.data?.floor ?? 0 };
    },
  });

  const done = async (tool: string, input: Record<string, unknown>): Done => {
    const r = await writeVia(tool, input);
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
    const r = await writeVia(tool, input);
    return r.error ? reason(r.error) : null;
  };

  return {
    ...source,
    viewer: () => viewer,
    head: () => head,
    // A # tag the person picked (a record, a vault item, a file) goes beside the words as { kind, id, name }: the box resolves it as the person, and a sealed part of a record reaches the assistant only as a placeholder.
    // Any chat takes a message through stream.send: the first one into a new chat starts its run (E3).
    sendText: async (text, o) => {
      const message = o?.message ?? newUuid();
      const route = routeComposerLine(text);
      const chips = o?.mentions?.slice(0, 8).map((m) => ({ kind: m.kind, id: m.id, name: m.name }));
      if (route.tool !== "threads.send" || !route.sendAsMessage) {
        const r = await writeVia("threads.slash", { chat: session, line: text, surface: SURFACE, ...(o?.mode ? { mode: o.mode } : {}), ...(chips?.length ? { mentions: chips } : {}) });
        return r.error ? reason(r.error) : null;
      }
      return note("stream.send", { chat: session, text, message, surface: SURFACE, tz: viewerZone(), ...(o?.mode ? { mode: o.mode } : {}), ...(o?.attachments?.length ? { attachments: o.attachments } : {}), ...(chips?.length ? { chips } : {}) });
    },
    stopSession: () => note("threads.chat-stop", { chat: session }),
    // The ask's own answer path (threads.answer): the same call the inbox swipe makes.
    answerAsk: (ask, decision) => note("threads.answer", { ask, decision: decision === "approve" ? "allow" : "deny", surface: SURFACE }),
    sendGroupText: async (text, opts = {}) => {
      const message = opts.message ?? newUuid();
      const route = routeComposerLine(text);
      if (route.tool !== "threads.send" || !route.sendAsMessage) {
        const r = await writeVia("threads.slash", { chat: session, line: text, surface: SURFACE, ...(opts.mode ? { mode: opts.mode } : {}) });
        if (r.error) return { ok: false, reason: reason(r.error) };
        return { ok: true, message, answers: [] };
      }
      const r = await writeVia("stream.send", { chat: session, text, message, surface: SURFACE, tz: viewerZone(), ...(opts.to?.length ? { to: opts.to } : {}), ...(opts.mode ? { mode: opts.mode } : {}), ...replyInput(opts.replyTo ? { message: opts.replyTo } : null), ...(opts.mentions?.length ? { mentions: opts.mentions } : {}), ...(opts.account ? { account: opts.account } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) });
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
    typing() { void writeVia("stream.typing", { chat: session }); },
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
