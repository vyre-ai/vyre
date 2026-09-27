// One open session, kept by chat's own core (deck/chat/core/session-state.js, imported as it is):
// read with threads.get, then fed by the box's event stream. The core mutates one Session and
// says which keys each event touched; this store turns that into three subscriptions, so a
// streaming reply repaints its one row, not the list:
//   list    rows came or went (or a tool changed its run)
//   row:k   that row's item changed
//   head    the header and the queue
// Notifications are coalesced to one per frame. Writes (threads.send, threads.unqueue,
// threads.interrupt) go through the outbox; the tools a box may not have yet are learnt through
// the core's caps probe.

import { applyEvent, createSession, dropLocal, localSend, type Queued, type Session, type SessionEvent } from "@vyre/chat-core/session-state.js";
import { groupItems } from "@vyre/chat-core/grouping.js";
import { newUuid, type SendMode } from "@vyre/chat-core/composer-state.js";
import { CAPS, NEEDS_UPDATE } from "@vyre/chat-core/caps.js";
import { call, listen, send } from "../api/box";
import type { BoxEvent } from "../api/client";
import { SURFACE } from "../state/live";
import { onlyPatches, sendOutcome, stateOf, toSessionEvent, transcriptRows, type TranscriptRow } from "./model";

const PAGE = 200;
const MAX_PAGE = 1000;
const KEEP = 3;

type Rec = { name: string | null; agent: string | null; project: string | null; model: string | null; status: string | null };

const raf: (f: () => void) => void = typeof requestAnimationFrame === "function" ? (f) => void requestAnimationFrame(f) : (f) => void setTimeout(f, 16);

function createStore(thread: string) {
  let s: Session = createSession(thread);
  let limit = PAGE;
  let loading = false;
  let loaded = false;
  let error: string | null = null;
  let hasMore = false;
  let rec: Rec = { name: null, agent: null, project: null, model: null, status: null };
  const open = new Set<string>();
  /** Live events that came while a read was on its way; applied after it (the core drops repeats by id). */
  let early: SessionEvent[] = [];

  let listRev = 0, headRev = 0;
  const rowRev = new Map<string, number>();
  const subs = { list: new Set<() => void>(), head: new Set<() => void>(), row: new Map<string, Set<() => void>>() };
  let rowsCache: { rev: number; open: string; rows: TranscriptRow[] } | null = null;

  // Coalesced notification: what changed since the last frame.
  const dirty = { list: false, head: false, rows: new Set<string>() };
  let scheduled = false;
  function flush() {
    scheduled = false;
    if (dirty.list) {
      dirty.list = false;
      listRev++;
      for (const f of subs.list) f();
    }
    if (dirty.head) {
      dirty.head = false;
      headRev++;
      for (const f of subs.head) f();
    }
    for (const k of dirty.rows) {
      rowRev.set(k, (rowRev.get(k) ?? 0) + 1);
      for (const f of subs.row.get(k) ?? []) f();
    }
    dirty.rows.clear();
  }
  function touch(keys: readonly string[]) {
    if (!keys.length) return;
    const drawn = new Set(rowsCache?.rows.map((r) => r.key) ?? []);
    if (!onlyPatches(keys, drawn, s.byKey)) dirty.list = true;
    for (const k of keys) {
      if (k === "@session" || k === "@queued") dirty.head = true;
      else if (!k.startsWith("@")) dirty.rows.add(k);
    }
    if (!scheduled) {
      scheduled = true;
      raf(flush);
    }
  }
  const all = () => {
    dirty.list = true;
    dirty.head = true;
    for (const it of s.items) dirty.rows.add(it.key);
    if (!scheduled) {
      scheduled = true;
      raf(flush);
    }
  };

  function onEvent(e: BoxEvent) {
    const mine = e.thread === thread || (e.payload && (e.payload as Record<string, unknown>).thread === thread);
    if (!mine) return;
    const ev = toSessionEvent(e, thread);
    if (!ev) return;
    if (loading || !loaded) {
      early.push(ev);
      return;
    }
    touch(applyEvent(s, ev));
  }
  const unlisten = listen(onEvent, () => void load());

  /** Read the newest `limit` events and rebuild the session from them (history grows above). */
  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    dirty.head = true;
    const r = await call<{ thread?: Record<string, unknown>; events?: unknown[] }>("threads.get", { thread, limit });
    loading = false;
    if (r.error) {
      error = r.error.message || r.error.code;
      all();
      return;
    }
    error = null;
    const t = r.data?.thread ?? {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    rec = { name: str(t.name), agent: str(t.agent), project: str(t.project), model: str(t.model), status: str(t.status) };
    const events = Array.isArray(r.data?.events) ? r.data.events : [];
    const next = createSession(thread);
    for (const e of events) {
      const ev = toSessionEvent(e, thread);
      if (ev) applyEvent(next, ev);
    }
    // The record's status is what is true now; the events may be a partial window of the past.
    if (!next.meta.stateSeen) next.state = stateOf(t.status, t.stopped_reason);
    if (!next.stopped && typeof t.stopped_reason === "string") next.stopped = t.stopped_reason;
    if (!next.model && rec.model) next.model = rec.model;
    // Words queued or steered on this screen before the reread stay drawn.
    for (const q of s.queued) if (q.local && !next.queued.some((x) => x.uuid === q.uuid)) next.queued.push(q);
    s = next;
    for (const ev of early) applyEvent(s, ev);
    early = [];
    hasMore = events.length >= limit && limit < MAX_PAGE;
    loaded = true;
    rowsCache = null;
    all();
  }

  async function write<T = unknown>(tool: string, input: Record<string, unknown>) {
    const { answered } = await send<T>(tool, input);
    return answered;
  }

  return {
    thread,
    get session() {
      return s;
    },
    get record() {
      return rec;
    },
    get status() {
      return { loading, loaded, error, hasMore };
    },
    load,
    /** Read further back: the history loads above the rows on screen. */
    async earlier() {
      if (!hasMore || loading) return;
      limit = Math.min(MAX_PAGE, limit * 2);
      await load();
    },
    rows(): TranscriptRow[] {
      const key = [...open].join("|");
      if (rowsCache && rowsCache.rev === listRev && rowsCache.open === key) return rowsCache.rows;
      const rows = transcriptRows(s.items, groupItems(s.items), open);
      rowsCache = { rev: listRev, open: key, rows };
      return rows;
    },
    toggle(runKey: string) {
      if (open.has(runKey)) open.delete(runKey);
      else open.add(runKey);
      dirty.list = true;
      dirty.rows.add(runKey);
      raf(flush);
    },
    isOpen: (k: string) => open.has(k),
    // Subscriptions for useSyncExternalStore.
    subscribeList(f: () => void) {
      subs.list.add(f);
      return () => void subs.list.delete(f);
    },
    listRev: () => listRev,
    subscribeHead(f: () => void) {
      subs.head.add(f);
      return () => void subs.head.delete(f);
    },
    headRev: () => headRev,
    subscribeRow(k: string, f: () => void) {
      let set = subs.row.get(k);
      if (!set) subs.row.set(k, (set = new Set()));
      set.add(f);
      return () => {
        set.delete(f);
        if (!set.size) subs.row.delete(k);
      };
    },
    rowRev: (k: string) => rowRev.get(k) ?? 0,

    /**
     * Send what the composer holds. Steer and queue are drawn at once (the core's localSend); a
     * plain send shows in the outbox strip until thread.sent draws it. A refusal takes back what
     * was drawn and returns why, so the words go back in the box.
     */
    async sendText(text: string, mode: SendMode | null): Promise<{ ok: true } | { ok: false; reason: string }> {
      const uuid = newUuid();
      touch(localSend(s, { uuid, text, mode, at: Date.now() }));
      const r = await write("threads.send", { thread, text, surface: SURFACE });
      const o = sendOutcome(r);
      if (!o.ok) {
        touch(dropLocal(s, uuid));
        return o;
      }
      return { ok: true };
    },
    /** Take a queued message back (threads.unqueue). */
    async takeBack(q: Queued): Promise<string | null> {
      if (q.local && q.queued == null && q.uuid) touch(dropLocal(s, q.uuid));
      const r = await CAPS.use("threads.unqueue", () => write("threads.unqueue", { thread, uuid: q.uuid, queued: q.queued }));
      if (r.missing) return NEEDS_UPDATE;
      return r.error ? r.error.message || "Could not take it back" : null;
    },
    /** Stop the running turn: threads.interrupt, or threads.stop on a box without it (as the Deck does). */
    async stop(): Promise<string | null> {
      let r = await CAPS.use("threads.interrupt", () => write("threads.interrupt", { thread }));
      if (r.missing) r = await write("threads.stop", { thread });
      return r.error ? r.error.message || "Could not stop" : null;
    },
    dispose() {
      unlisten();
    },
  };
}

export type SessionStore = ReturnType<typeof createStore>;

/** The last few sessions opened stay alive (and listening), so going back is a paint. */
const stores = new Map<string, SessionStore>();

export function sessionStore(thread: string): SessionStore {
  let st = stores.get(thread);
  if (st) {
    stores.delete(thread);
    stores.set(thread, st);
    return st;
  }
  st = createStore(thread);
  stores.set(thread, st);
  void st.load();
  while (stores.size > KEEP) {
    const [k, old] = stores.entries().next().value as [string, SessionStore];
    old.dispose();
    stores.delete(k);
  }
  return st;
}
