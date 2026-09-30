// One open session, kept by chat's own core (deck/chat/core/session-state.js, imported as it is),
// held to the native bar (docs/design/native-bar.md). The core mutates one Session and says which
// keys each event touched; this store turns that into three subscriptions, so a streaming reply
// repaints its one row, not the list:
//   list    rows came or went (or a tool changed its run)
//   row:k   that row's item changed, or its paced reveal moved
//   head    the header, the queue, the stop chip
//
// One frame clock. Everything that changed since the last frame, and every streaming reply's
// reveal (chat core pace.js through reveal.js), is published in one frame callback, so a frame
// is one React commit however many rows moved. With nothing streaming and nothing changed no
// frame is asked for: idle costs no timer.
//
// Open: the last events of the session come from this device's view cache first (painted before
// the box answers), then threads.get since the newest of them. A reconnect or a stream reset
// reads since the newest event applied the same way; the core drops an event id it has applied,
// so nothing shows twice, nothing goes blank and no row moves.
//
// Writes (threads.send, .interrupt, .stop, .unqueue, .model, .rewind) go through the outbox with
// an Idempotency-Key. Send paints the user row at once under u:<uuid>, and the box's echo or
// answer adopts that same key, so the row never flickers or moves. The tools a box may not have
// yet are learnt through the core's caps probe.

import {
  applyEvent,
  checkpoints,
  confirmSend,
  contextLabel,
  createSession,
  dropLocal,
  filesNote,
  localSend,
  type Queued,
  type Session,
  type SessionEvent,
} from "@vyre/chat-core/session-state.js";
import { groupItems } from "@vyre/chat-core/grouping.js";
import { createPacer } from "@vyre/chat-core/pace.js";
import { modelChoices, newUuid, type SendMode } from "@vyre/chat-core/composer-state.js";
import { normalizeCommands, type Command } from "@vyre/chat-core/commands.js";
import { CAPS, NEEDS_UPDATE, REWIND_CODE } from "@vyre/chat-core/caps.js";
import { call, listen, send } from "../api/box";
import type { BoxEvent } from "../api/client";
import { perf, takeOpening, thisPaint } from "../perf";
import { viewCache } from "../state/cache";
import { onConnection, type Connection } from "../state/connection";
import { SURFACE } from "../state/live";
import { appendLog, boxToScreen, busy, onlyPatches, sendOutcome, stateOf, stoppedOf, toSessionEvent, transcriptRows, type TranscriptRow } from "./model";
import { createReveal } from "./reveal.js";
import { drawSend } from "./send.js";

const PAGE = 200;
const MAX_PAGE = 1000;
/** A catch-up reads at most this many events; more means too much was missed, so it reads afresh. */
const CATCH_UP = 500;
/** Events kept for the view cache (streamed text folded, appendLog). */
const CACHE_EVENTS = 400;
const KEEP = 3;
const COMMANDS_RETRY_MS = 30_000;

type Rec = { name: string | null; agent: string | null; project: string | null; model: string | null; status: string | null };
type Cached = { v: 1; rec: Rec; events: SessionEvent[]; hasMore: boolean };
export type SendResult = { ok: true } | { ok: false; reason: string };

const raf: (f: (t: number) => void) => void =
  typeof requestAnimationFrame === "function" ? (f) => void requestAnimationFrame(f) : (f) => void setTimeout(() => f(perf.now()), 16);
const epoch = () => Date.now();

function createStore(thread: string) {
  let s: Session = createSession(thread);
  let limit = PAGE;
  let loading = false;
  let loaded = false;
  let from: "none" | "cache" | "box" = "none";
  let error: string | null = null;
  let hasMore = false;
  let rec: Rec = { name: null, agent: null, project: null, model: null, status: null };
  const open = new Set<string>();
  /** Live events that came before the first paint; applied after it (the core drops repeats by id). */
  let early: SessionEvent[] = [];
  /** What the session was built from, for the view cache. */
  let log: SessionEvent[] = [];
  const reveal = createReveal({ createPacer });
  /** The box's stamp on a reply's first event, for box to screen. */
  const stamps = new Map<string, number>();
  /** Stop was pressed: when, until the turn has ended. */
  let stopping: number | null = null;
  let draft = "";
  let draftSaving: ReturnType<typeof setTimeout> | null = null;
  const draftSubs = new Set<(text: string, force: boolean) => void>();
  let commands: Command[] | null = null;
  let commandsAt = 0;

  let listRev = 0, headRev = 0;
  const rowRev = new Map<string, number>();
  const subs = { list: new Set<() => void>(), head: new Set<() => void>(), row: new Map<string, Set<() => void>>() };
  let rowsCache: { rev: number; open: string; rows: TranscriptRow[]; drawn: Set<string> } | null = null;

  // ---- the frame ---------------------------------------------------------------------------

  const dirty = { list: false, head: false, rows: new Set<string>() };
  /** Paints to time: a mark and what must have been published for it to count. */
  let marks: { name: string; t0: number; key?: string }[] = [];
  let openAt: number | null = null;
  /** The open being timed started with the rows already here (kept alive, or read from the cache). */
  let openWarm = false;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    raf(frame);
  };

  function frame(t: number) {
    scheduled = false;
    const r = reveal.frame(t);
    let moved = false;
    for (const c of r.changed) {
      dirty.rows.add(c.key);
      if (!c.done) moved = true;
      if (c.first && c.arrived !== null) {
        const arrived = c.arrived;
        const stamp = stamps.get(c.key);
        stamps.delete(c.key);
        thisPaint((tp) => {
          perf.record("stream.first", tp - arrived);
          const box = boxToScreen(stamp, epoch());
          if (box !== null) perf.record("stream.box", box);
        });
      }
    }
    if (moved) perf.gap("stream", t);
    for (const n of r.samples) perf.record("stream.cpf", n);
    if (r.changed.some((c) => c.done) && !r.active) perf.endGap("stream");

    const published = new Set<string>();
    if (dirty.list) {
      dirty.list = false;
      listRev++;
      published.add("@list");
      for (const f of subs.list) f();
    }
    if (dirty.head) {
      dirty.head = false;
      headRev++;
      published.add("@head");
      for (const f of subs.head) f();
    }
    for (const k of dirty.rows) {
      rowRev.set(k, (rowRev.get(k) ?? 0) + 1);
      published.add(k);
      for (const f of subs.row.get(k) ?? []) f();
    }
    dirty.rows.clear();

    if (perf.on && marks.length) {
      const due = marks.filter((m) => !m.key || published.has(m.key) || published.has("@list"));
      if (due.length) {
        marks = marks.filter((m) => !due.includes(m));
        thisPaint((tp) => {
          for (const m of due) perf.record(m.name, tp - m.t0);
        });
      }
    }
    if (openAt !== null && loaded && published.has("@list")) {
      const t0 = openAt, name = openWarm || from === "cache" ? "open.session.cache" : "open.session.cold";
      openAt = null;
      thisPaint((tp) => perf.record(name, tp - t0));
    }
    if (r.active) schedule();
  }

  /** What an event (or a local change) touched: rows, the list, the head; and the reveal for streaming text. */
  function touch(keys: readonly string[], arrived?: number) {
    if (!keys.length) return;
    if (!rowsCache || !onlyPatches(keys, rowsCache.drawn, s.byKey)) dirty.list = true;
    for (const k of keys) {
      if (k === "@session" || k === "@queued" || k === "@rewound") dirty.head = true;
      else if (k.startsWith("@")) continue;
      else {
        dirty.rows.add(k);
        const it = s.byKey.get(k);
        if (!it) reveal.drop(k);
        else if (it.kind === "text") {
          // A reply streaming live is paced from its arrival; text read (a catch-up) shows as it is.
          if (reveal.has(k) || (it.streaming && arrived !== undefined)) {
            reveal.push(k, it.text.length, arrived ?? perf.now());
            if (!it.streaming) reveal.finish(k);
          } else reveal.seed(k, it.text.length);
        }
      }
    }
    if (stopping !== null && !busy(s.state)) {
      stopping = null;
      dirty.head = true;
    }
    schedule();
  }

  /** Everything changed (a new session read): the rows, the head; text on screen is not paced again. */
  function all() {
    dirty.list = true;
    dirty.head = true;
    rowsCache = null;
    const t = perf.now();
    for (const it of s.items) {
      dirty.rows.add(it.key);
      if (it.kind !== "text") continue;
      if (!reveal.has(it.key)) reveal.seed(it.key, it.text.length);
      else {
        reveal.push(it.key, it.text.length, t);
        if (!it.streaming) reveal.finish(it.key);
      }
    }
    schedule();
  }

  // ---- reading ------------------------------------------------------------------------------

  function apply(ev: SessionEvent) {
    log = appendLog(log, ev, CACHE_EVENTS);
    return applyEvent(s, ev);
  }

  function onEvent(e: BoxEvent) {
    const mine = e.thread === thread || (e.payload && (e.payload as Record<string, unknown>).thread === thread);
    if (!mine) return;
    const t = perf.now();
    const ev = toSessionEvent(e, thread);
    if (!ev) return;
    if (!loaded) {
      early.push(ev);
      return;
    }
    const keys = apply(ev);
    if (ev.type === "thread.text") {
      const stamp = (ev.payload as Record<string, unknown> | undefined)?.t;
      for (const k of keys) if (typeof stamp === "number" && !reveal.has(k) && !stamps.has(k)) stamps.set(k, stamp);
    }
    touch(keys, t);
    if (ev.type === "thread.finished" || ev.type === "thread.stopped") void save();
  }

  const unlisten = listen(onEvent, (e) => {
    // vyred's log is behind this device's cursor: ids start again below what was seen.
    if (typeof e.id === "number" && s.meta.lastId > e.id) s.meta.lastId = e.id;
    void catchUp();
  });
  // Back from a drop: the stream resumes from its cursor, and a read since the newest event
  // applied fills anything the box did not replay.
  let conn: Connection = "live";
  const unconn = onConnection((c) => {
    const was = conn;
    conn = c.status;
    if (conn === "live" && was !== "live" && loaded) void catchUp();
  });

  function recordOf(t: Record<string, unknown>): Rec {
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { name: str(t.name), agent: str(t.agent), project: str(t.project), model: str(t.model), status: str(t.status) };
  }

  /** The record's state is what is true now, unless an event in this read said it. */
  function stateFromRecord(t: Record<string, unknown>, events: readonly SessionEvent[]) {
    if (events.some((e) => e.type === "thread.state")) return;
    const st = stateOf(t.status, t.stopped_reason);
    if (st !== s.state) {
      s.state = st;
      dirty.head = true;
    }
    const why = stoppedOf(t.status, t.stopped_reason);
    if (why && !s.stopped) s.stopped = why;
  }

  /** Build a session from events (the cache's, or a read of the newest `limit`), in one swap: no blank. */
  function rebuild(events: readonly SessionEvent[]) {
    const next = createSession(thread);
    const nextLog: SessionEvent[] = [];
    for (const ev of events) {
      appendLog(nextLog, ev, CACHE_EVENTS);
      applyEvent(next, ev);
    }
    // Words queued or steered on this screen before the reread stay drawn.
    for (const q of s.queued) if (q.local && !next.queued.some((x) => x.uuid === q.uuid)) next.queued.push(q);
    s = next;
    log = nextLog;
    for (const ev of early) apply(ev);
    early = [];
  }

  /** Read the newest `limit` events and build the session from them (history grows above). */
  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    dirty.head = true;
    schedule();
    const r = await call<{ thread?: Record<string, unknown>; events?: unknown[] }>("threads.get", { thread, limit });
    loading = false;
    if (r.error) {
      // What shows (the cache's) stays; the note says why it is not current.
      error = r.error.message || r.error.code;
      dirty.head = true;
      schedule();
      return;
    }
    error = null;
    const t = r.data?.thread ?? {};
    rec = recordOf(t);
    const events = (Array.isArray(r.data?.events) ? r.data.events : []).map((e) => toSessionEvent(e, thread)).filter((e): e is SessionEvent => !!e);
    rebuild(events);
    if (!s.meta.stateSeen) stateFromRecord(t, events);
    if (!s.stopped) s.stopped = stoppedOf(t.status, t.stopped_reason);
    if (!s.model && rec.model) s.model = rec.model;
    hasMore = events.length >= limit && limit < MAX_PAGE;
    loaded = true;
    from = "box";
    all();
    void save();
  }

  /** Read what came since the newest event applied, and apply it to what shows. */
  let catching: Promise<void> | null = null;
  let again = false;
  function catchUp(): Promise<void> {
    if (!loaded) return load();
    if (catching) {
      again = true;
      return catching;
    }
    catching = (async () => {
      do {
        again = false;
        const since = Number.isFinite(s.meta.lastId) ? s.meta.lastId : 0;
        const r = await call<{ thread?: Record<string, unknown>; events?: unknown[] }>("threads.get", { thread, since, limit: CATCH_UP });
        if (r.error) {
          if (from === "cache") {
            error = r.error.message || r.error.code;
            dirty.head = true;
            schedule();
          }
          return;
        }
        const raw = Array.isArray(r.data?.events) ? r.data.events : [];
        // More than a catch-up reads: too much was missed to stitch; read afresh.
        if (raw.length >= CATCH_UP) {
          await load();
          return;
        }
        error = null;
        const t = r.data?.thread ?? {};
        rec = recordOf(t);
        const events = raw.map((e) => toSessionEvent(e, thread)).filter((e): e is SessionEvent => !!e);
        const touched = new Set<string>(["@session"]);
        for (const ev of events) for (const k of apply(ev)) touched.add(k);
        stateFromRecord(t, events);
        if (!s.model && rec.model) s.model = rec.model;
        from = "box";
        touch([...touched]);
      } while (again);
      void save();
    })().finally(() => {
      catching = null;
    });
    return catching;
  }

  /** The session as this device last saw it, painted before the box answers. */
  async function fromCache(): Promise<void> {
    const c = await viewCache.get<Cached>(`session:${thread}`);
    if (loaded || !c || c.v !== 1 || !Array.isArray(c.events)) return;
    rec = c.rec;
    rebuild(c.events);
    if (!s.model && rec.model) s.model = rec.model;
    hasMore = c.hasMore;
    loaded = true;
    from = "cache";
    all();
  }

  async function save() {
    if (from === "none") return;
    await viewCache.set(`session:${thread}`, { v: 1, rec, events: log, hasMore: hasMore || log.length >= CACHE_EVENTS } satisfies Cached);
  }

  async function start() {
    const d = await viewCache.get<string>(`draft:${thread}`);
    if (typeof d === "string" && d && !draft) {
      draft = d;
      for (const f of draftSubs) f(d, false);
    }
  }

  async function begin() {
    void start();
    await fromCache();
    await (loaded ? catchUp() : load());
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
      return { loading, loaded, error, hasMore, from };
    },
    /** Pressed Stop, and the box has not said the turn ended. */
    get stopping() {
      return stopping !== null;
    },
    /** "62% of context", when the box says it. */
    context: () => contextLabel(s.usage),
    begin,
    load,
    catchUp,
    /** The screen opened (from a tap, or back to a session kept alive): open.session.* times it to the rows' paint. */
    opened() {
      if (!perf.on) return;
      openAt = takeOpening();
      openWarm = loaded;
      if (loaded) {
        dirty.list = true;
        schedule();
      }
    },
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
      rowsCache = { rev: listRev, open: key, rows, drawn: new Set(rows.map((r) => r.key)) };
      return rows;
    },
    /** How much of a streaming reply shows now; undefined: all of it. */
    shown: (k: string) => reveal.shown(k),
    toggle(runKey: string) {
      if (open.has(runKey)) open.delete(runKey);
      else open.add(runKey);
      dirty.list = true;
      dirty.rows.add(runKey);
      schedule();
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

    // ---- the draft ----------------------------------------------------------------------------

    get draft() {
      return draft;
    },
    /** The composer's words, kept per session in memory and in the view cache (saved once typing pauses). */
    setDraft(text: string) {
      draft = text;
      if (draftSaving) clearTimeout(draftSaving);
      draftSaving = setTimeout(() => {
        draftSaving = null;
        void viewCache.set(`draft:${thread}`, draft);
      }, 400);
    },
    /** Words for the box from elsewhere (a rewind's): they replace what is typed. */
    prefill(text: string) {
      this.setDraft(text);
      for (const f of draftSubs) f(text, true);
    },
    /** The cached draft arrived after the composer drew (force false: only into an empty box), or a prefill (force true). */
    onDraft(f: (text: string, force: boolean) => void) {
      draftSubs.add(f);
      return () => void draftSubs.delete(f);
    },

    // ---- writes -------------------------------------------------------------------------------

    /**
     * Send what the composer holds. The words are drawn at once: a message under u:<uuid> (the
     * box's thread.sent, or its answer's uuid, adopts that key), a steer with its marker, a queued
     * row above the composer. A refusal takes back what was drawn and returns why, so the words
     * go back in the box.
     */
    async sendText(text: string, mode: SendMode | null): Promise<SendResult> {
      const t0 = perf.now();
      const uuid = newUuid();
      const was = s.state;
      const keys = drawSend(s, { uuid, text, mode, at: epoch(), surface: SURFACE });
      const key = mode === "queue" ? "@head" : (s.meta.uuids.get(uuid) ?? "@list");
      if (perf.on) marks.push({ name: "send.paint", t0, key });
      touch(keys);
      const r = await write("threads.send", { thread, text, surface: SURFACE, uuid, ...(mode ? { mode } : {}) });
      const o = sendOutcome(r);
      if (!o.ok) {
        if (!s.meta.stateSeen && s.state !== was) s.state = was;
        touch([...dropLocal(s, uuid), "@session"]);
        return o;
      }
      if (o.queued) {
        // Queued (asked for, or the session is busy in a terminal): the row names its id now. A
        // steer drawn on send was not one; it becomes the row.
        if (mode !== "queue") touch(dropLocal(s, uuid));
        else touch(confirmSend(s, uuid, o.uuid));
        touch(localSend(s, { uuid: o.uuid || uuid, text, mode: "queue", at: epoch(), queued: o.id }));
        return { ok: true };
      }
      if (o.uuid) touch(confirmSend(s, uuid, o.uuid));
      return { ok: true };
    },
    /** Take a queued message back (threads.unqueue). */
    async takeBack(q: Queued): Promise<string | null> {
      if (q.local && q.queued == null && q.uuid) touch(dropLocal(s, q.uuid));
      const r = await CAPS.use("threads.unqueue", () => write("threads.unqueue", { thread, uuid: q.uuid, queued: q.queued }));
      if (r.missing) return NEEDS_UPDATE;
      if (r.error) return r.error.message || "Could not take it back";
      s.queued = s.queued.filter((x) => x !== q);
      touch(["@queued"]);
      return null;
    },
    /**
     * Stop the running turn. The chip says "stopping" in this frame; threads.interrupt, or
     * threads.stop on a box without it (as the Deck does). A refusal puts the chip back.
     */
    async stop(): Promise<string | null> {
      if (stopping !== null || !busy(s.state)) return null;
      stopping = perf.now();
      if (perf.on) marks.push({ name: "stop.paint", t0: stopping, key: "@head" });
      dirty.head = true;
      schedule();
      let r = await CAPS.use("threads.interrupt", () => write("threads.interrupt", { thread }));
      if (r.missing) r = await write("threads.stop", { thread });
      if (r.error) {
        stopping = null;
        dirty.head = true;
        schedule();
        return "Could not stop: " + (r.error.message || r.error.code);
      }
      return null;
    },

    // ---- the Deck's session controls ---------------------------------------------------------

    /** The session's "/" commands (threads.commands), else the static list; asked again while the session gives none. */
    async commands(): Promise<Command[]> {
      if (commands && (!commandsAt || Date.now() - commandsAt < COMMANDS_RETRY_MS)) return commands;
      const r = await CAPS.use("threads.commands", () => call("threads.commands", { thread }));
      const d = r.data as { commands?: unknown } | unknown[] | undefined;
      const got = Array.isArray(d) ? d : Array.isArray((d as { commands?: unknown })?.commands) ? ((d as { commands: unknown[] }).commands) : null;
      commands = normalizeCommands(got);
      commandsAt = got && got.length ? 0 : r.missing ? 0 : Date.now();
      return commands;
    },
    /** The model picker's rows (sessions.models.get's per-purpose map, the aliases, this session's). */
    async models() {
      const r = await CAPS.use("sessions.models.get", () => call<{ purposes?: unknown }>("sessions.models.get", {}));
      return modelChoices({ current: s.model, purposes: (r.data as { purposes?: unknown } | undefined)?.purposes, seen: [rec.model] });
    },
    canSwitchModel: () => CAPS.has("threads.model") !== false,
    /** Switch the model (threads.model): the chip moves now, and back with why on a refusal. */
    async setModel(id: string): Promise<string | null> {
      if (CAPS.has("threads.model") === false) return NEEDS_UPDATE;
      const was = s.model;
      s.model = id;
      touch(["@session"]);
      const r = await CAPS.use("threads.model", () => write("threads.model", { thread, model: id }));
      if (r.error) {
        s.model = was;
        touch(["@session"]);
        return r.missing ? NEEDS_UPDATE : "Could not switch the model: " + (r.error.message || r.error.code);
      }
      const note = (r.data as { note?: unknown } | undefined)?.note;
      return typeof note === "string" && note ? note : null;
    },
    /** Messages a rewind can go back to, newest first. */
    checkpoints: () => checkpoints(s),
    canRewind: () => CAPS.has("threads.rewind") !== false,
    canRestoreCode: () => CAPS.has(REWIND_CODE) !== false,
    /**
     * Rewind to just before a message (threads.rewind): the rows from it on leave, and its words
     * come back for the composer. "code" puts only the files back; "both" does both.
     */
    async rewind(p: { uuid: string; text: string }, restore: "conversation" | "code" | "both"): Promise<{ note: string | null; text: string | null }> {
      const r = await CAPS.use("threads.rewind", () => write("threads.rewind", { thread, uuid: p.uuid, ...(restore !== "conversation" ? { restore } : {}) }));
      if (r.error) return { note: r.missing ? NEEDS_UPDATE : (restore === "code" ? "Could not restore the files: " : "Could not rewind: ") + (r.error.message || r.error.code), text: null };
      const d = (r.data ?? {}) as { uuid?: string; text?: string; files?: unknown; rewound?: boolean; note?: string };
      const uuid = d.uuid || p.uuid;
      if (restore === "code") {
        touch(applyEvent(s, { type: "thread.rewound", at: epoch(), payload: { thread, uuid, restore: "code", files: d.files ?? null, local: true } }));
        return { note: null, text: null };
      }
      if (d.rewound === false) {
        const f = filesNote(d.files);
        return { note: String(d.note || "This message cannot be rewound to.") + (f ? ` ${f}.` : ""), text: null };
      }
      const text = typeof d.text === "string" ? d.text : p.text;
      touch(applyEvent(s, { type: "thread.rewound", at: epoch(), payload: { thread, uuid, text, ...(d.files ? { files: d.files } : {}), local: true } }));
      return { note: null, text };
    },
    dispose() {
      unlisten();
      unconn();
      void save();
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
  void st.begin();
  while (stores.size > KEEP) {
    const [k, old] = stores.entries().next().value as [string, SessionStore];
    old.dispose();
    stores.delete(k);
  }
  return st;
}
