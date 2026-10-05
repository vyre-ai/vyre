// The chat store: one session stream folded into rows, and the one frame clock that reveals
// streaming text (chat core pace.js through ../session/reveal.js). `useSessionStream(sessionId)` is
// the one door: it takes any StreamSource (the real core/stream client when it lands, or the mock)
// and returns the folded rows, the status and the queue. Each row subscribes to its own key, so a
// streaming reply repaints only itself; the list re-lays only when a row is added.
//
// Frames that arrive in the same tick (a resume replay, a burst) are applied together and
// notified once. Text replayed on connect shows as it is; only live text is paced.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPacer } from "@vyre/chat-core/pace.js";
import { createReveal } from "../session/reveal.js";
import { createFolder, headerState, type Frame as FoldFrame, type Item, type LayoutRow } from "./frames.js";
import { createMockStream, type Frame, type StreamSource, type StreamState } from "./mock-stream";
import { boxStream, type GroupActions, type SessionActions } from "./box-stream";
import { createGroup } from "./group.js";

export type Meta = { state: string; turn: string | null; stopping: boolean; word: string; busy: boolean; canStop: boolean; queue: readonly Item[]; connection: StreamState; rev: number };
export type PerfSink = (name: "paint.delta" | "paint.first", ms: number) => void;
export type ChatStore = {
  readonly session: string;
  start(): void;
  stop(): void;
  subscribeLayout(f: () => void): () => void;
  subscribeRow(key: string, f: () => void): () => void;
  subscribeMeta(f: () => void): () => void;
  rows(): readonly LayoutRow[];
  item(key: string): Item | null;
  rowRev(key: string): number;
  /** Characters of a streaming reply on screen; undefined when it is not paced (show all). */
  shown(key: string): number | undefined;
  meta(): Meta;
  /** Resolves with why the box refused it, or null. */
  send(text: string, o?: { mentions?: { kind: string; id: string; name: string }[] }): Promise<string | null>;
  interrupt(): Promise<string | null>;
  answer(ask: string, decision: "approve" | "deny"): Promise<string | null>;
  /** The group side: authors, presence, reactions, pins, threads, the read marker, fan-out sets (group.js). */
  readonly group: ReturnType<typeof createGroup>;
  subscribeGroup(f: () => void): () => void;
  /** Send to chosen assistants (two or more make a fan-out). Falls back to a plain send when the source cannot. */
  sendTo(text: string, o: { to: string[]; fanout: boolean; parent?: string; mentions?: { kind: string; id: string; name: string }[] }): Promise<string | null>;
  /** Social actions; each is a no-op when the source does not have it. */
  social: { keep(group: string, message: string): void; react(message: string, emoji: string, remove?: boolean): void; pin(message: string, pinned: boolean): void; markRead(upto: number): void };
  /** Edit and retry, retry and branch: only a real session has them (the mock does not). */
  readonly actions: Partial<Pick<SessionActions, "editRetry" | "retry" | "branch">> | null;
};

const withActions = (source: StreamSource): Partial<SessionActions & GroupActions> => source as unknown as Partial<SessionActions & GroupActions>;

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const frameSoon = (fn: (t: number) => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(() => fn(nowMs()), 16) as unknown as number);

export function createChatStore(session: string, source: StreamSource, opts: { perf?: PerfSink; viewer?: string } = {}): ChatStore {
  const folder = createFolder();
  const group = createGroup(opts.viewer ?? "person:alex");
  const groupSubs = new Set<() => void>();
  const reveal = createReveal({ createPacer });
  const layoutSubs = new Set<() => void>();
  const metaSubs = new Set<() => void>();
  const rowSubs = new Map<string, Set<() => void>>();
  let metaRev = 0;
  let metaSnap: Meta | null = null;
  let connection: StreamState = "connecting";
  let conn: { close(): void } | null = null;
  let buffer: Frame[] = [];
  let scheduled = false;
  let replay = true;
  let looping = false;
  let stopping = false;
  /** Delta frames waiting to be seen: their message, the length that must show, and when they were emitted. */
  const pending: { key: string; end: number; t: number; first: boolean }[] = [];
  const seenFirst = new Set<string>();

  const local = new Map<string, number>();
  const notifyRow = (k: string) => { local.set(k, (local.get(k) ?? 0) + 1); const s = rowSubs.get(k); if (s) for (const f of [...s]) f(); };
  const bumpMeta = () => { metaRev++; metaSnap = null; for (const f of [...metaSubs]) f(); };

  function tick(t: number) {
    const r = reveal.frame(t);
    const done: { t: number; first: boolean }[] = [];
    for (const c of r.changed) {
      notifyRow(c.key);
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (p.key === c.key && (c.done || p.end <= c.shown)) { done.push({ t: p.t, first: p.first }); pending.splice(i, 1); }
      }
    }
    if (done.length && opts.perf) {
      const sink = opts.perf;
      // The task posted from the frame callback runs after the frame that committed these rows painted.
      setTimeout(() => { const n = nowMs(); for (const d of done) sink(d.first ? "paint.first" : "paint.delta", n - d.t); }, 0);
    }
    if (r.active) frameSoon(tick);
    else looping = false;
  }
  function wake() {
    if (looping) return;
    looping = true;
    frameSoon(tick);
  }

  function flush() {
    scheduled = false;
    const frames = buffer;
    buffer = [];
    if (!frames.length) return;
    // History shows at once: the first batch, and any batch that only holds frames up to the head the box said at open (a long reply replayed in many messages is not typed out again).
    const head = source.head?.() ?? 0;
    const wasReplay = replay || (head > 0 && frames.every((f) => !((f.cur ?? 0) > head)));
    replay = false;
    const touched = new Set<string>();
    const appended = new Map<string, number>();
    const finished = new Set<string>();
    let layout = false;
    let meta = false;
    let reset = false;
    let groupChanged = false;
    const v = source.viewer?.();
    if (v && v !== group.viewer) { group.setViewer(v); groupChanged = true; }
    for (const f of frames) {
      const g = group.apply(f as never);
      if (g.meta || g.touched.length) groupChanged = true;
      for (const k of g.touched) touched.add(k);
      const before = folder.status.state;
      const r = folder.apply(f as FoldFrame);
      if (folder.status.state !== before) meta = true;
      if (r.dup) continue;
      if (r.reset) { reset = true; layout = true; meta = true; continue; }
      if (r.layout) layout = true;
      if (r.appended) {
        appended.set(r.appended.key, r.appended.length);
        if (!wasReplay) pending.push({ key: r.appended.key, end: r.appended.length, t: f.t ?? nowMs(), first: !seenFirst.has(r.appended.key) });
        seenFirst.add(r.appended.key);
      }
      if (f.type === "session.text-done") finished.add("a:" + f.data.message);
      if (f.type === "session.status" || f.type === "session.user-message") meta = true;
      for (const k of r.touched) touched.add(k);
    }
    if (reset) { for (const k of seenFirst) reveal.drop(k); seenFirst.clear(); pending.length = 0; }
    const now = nowMs();
    for (const [key, len] of appended) {
      if (wasReplay) { reveal.drop(key); reveal.seed(key, len); } // history shows whole, even a reply that was being typed when the link dropped
      else reveal.push(key, len, now);
    }
    for (const key of finished) if (!wasReplay) reveal.finish(key);
    if (appended.size && !wasReplay) wake();
    if (finished.size && !wasReplay) wake();
    if (stopping && !folder.status.stopping && ["stopped", "waiting", "finished", "failed", "paused"].includes(folder.status.state)) stopping = false;
    if (layout) for (const f of [...layoutSubs]) f();
    for (const k of touched) if (!appended.has(k) || wasReplay || finished.has(k)) notifyRow(k);
    // A reply that streams repaints at the frame clock; its first characters show on the next frame.
    if (meta || layout) bumpMeta();
    if (groupChanged) for (const f of [...groupSubs]) f();
  }
  function onFrame(f: Frame) {
    buffer.push(f);
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  }

  const store: ChatStore = {
    session,
    start() {
      if (conn) return;
      conn = source.connect({ from: folder.last, onFrame, onState: (s) => { connection = s; bumpMeta(); } });
    },
    stop() { conn?.close(); conn = null; },
    subscribeLayout(f) { layoutSubs.add(f); return () => void layoutSubs.delete(f); },
    subscribeRow(k, f) {
      let s = rowSubs.get(k);
      if (!s) rowSubs.set(k, (s = new Set()));
      s.add(f);
      return () => { s!.delete(f); if (!s!.size) rowSubs.delete(k); };
    },
    subscribeMeta(f) { metaSubs.add(f); return () => void metaSubs.delete(f); },
    rows: () => folder.rows,
    item: (k) => folder.item(k),
    rowRev: (k) => local.get(k) ?? 0,
    shown: (k) => reveal.shown(k),
    meta() {
      if (metaSnap) return metaSnap;
      const s = folder.status;
      const h = headerState({ state: s.state, stopping: s.stopping || stopping });
      return (metaSnap = { state: s.state, turn: s.turn, stopping: s.stopping || stopping, word: h.word, busy: h.busy, canStop: h.canStop, queue: folder.queue(), connection, rev: metaRev });
    },
    async send(text, o) {
      if (!text.trim()) return null;
      const a = withActions(source);
      // A group chat on a real box (it has assistants in its participant list) goes through stream.send, which routes by mention.
      if (a.sendGroupText && group.participants().some((p) => p.family === "assistant")) {
        const r = await a.sendGroupText(text, o?.mentions?.length ? { mentions: o.mentions.map((m) => m.id) } : undefined);
        return r.ok ? null : r.reason;
      }
      if (a.sendText) return a.sendText(text, o);
      source.send(text);
      return null;
    },
    async interrupt() {
      if (!store.meta().canStop) return null;
      stopping = true;
      bumpMeta();
      const a = withActions(source);
      if (!a.stopSession) { source.stop(); return null; }
      const why = await a.stopSession();
      if (why) { stopping = false; bumpMeta(); return "Could not stop: " + why; }
      return null;
    },
    async answer(ask, decision) {
      const a = withActions(source);
      if (a.answerAsk) return a.answerAsk(ask, decision);
      source.answer(ask, decision);
      return null;
    },
    group,
    subscribeGroup(f) { groupSubs.add(f); return () => void groupSubs.delete(f); },
    async sendTo(text, o) {
      if (!text.trim()) return null;
      const a = withActions(source);
      if (a.sendGroupText && group.participants().some((p) => p.family === "assistant")) {
        const r = await a.sendGroupText(text, { to: o.to, ...(o.mentions?.length ? { mentions: o.mentions.map((m) => m.id) } : {}) });
        return r.ok ? null : r.reason;
      }
      if (source.sendGroup && (o.to.length || o.fanout || o.parent)) { source.sendGroup(text, o); return null; }
      return store.send(text, o.mentions?.length ? { mentions: o.mentions } : undefined);
    },
    social: {
      keep: (g, m) => source.keep?.(g, m),
      react: (m, e, r) => source.react?.(m, e, r),
      pin: (m, p) => source.pin?.(m, p),
      markRead: (u) => source.markRead?.(u),
    },
    get actions() {
      const a = withActions(source);
      return a.editRetry && a.retry && a.branch ? { editRetry: a.editRetry, retry: a.retry, branch: a.branch } : null;
    },
  };
  return store;
}

/** The source for a session id: the mock for `demo`, the real client against the box for every other id. */
export const sourceFor = (sessionId: string): StreamSource => (sessionId === "demo" ? createMockStream({ session: "demo" }) : boxStream(sessionId));

/**
 * The one door for a session's frames. `source` is a StreamSource (the mock, or core/stream's
 * `connect({ open, from })` wrapped to this shape); without one, `demo` gets the mock and every other id the real client.
 * Returns the folded rows and the header facts; `store` serves each row its own content.
 */
export function useSessionStream(sessionId: string, opts: { source?: StreamSource; perf?: PerfSink; viewer?: string } = {}) {
  const store = useMemo(() => createChatStore(sessionId, opts.source ?? sourceFor(sessionId), { perf: opts.perf, viewer: opts.viewer }), [sessionId, opts.source]);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  const rows = useSyncExternalStore(store.subscribeLayout, store.rows, store.rows);
  useSyncExternalStore(store.subscribeGroup, () => store.group.rev, () => store.group.rev);
  const meta = useSyncExternalStore(store.subscribeMeta, store.meta, store.meta);
  return { store, rows, meta, loading: rows.length === 0 && meta.connection !== "offline" && meta.state === "starting" };
}
