// @ts-check
// The planner's data, held in the Space's records (ADR 0025 is the planner; team/0.3 puts Planner on Records). Nothing here is a
// table of the planner's own. Where each thing lives:
//   alarms, timers, reminders and `task` items (an instruction that runs later)   record type `reminder`
//   notes                                                                          record type `note`
//   the planner's own events and the connected calendars' events                    record type `event` (source vyre, or the account)
//   todos                                                                          the kernel's Tasks, the doer the person
//   one row per firing, and the planner's settings                                  system record types `planner-ring` and `planner-state`
//
// The scheduler and the tools read rows synchronously, so the store keeps the live rows in memory and writes every change to its
// record behind them, in order. A tool awaits `flush()` before it answers, so an answer means the record is written. A record
// someone else changes (the Records screens, a calendar sync) is read back into the rows from the Space's own events.
// The row shape is the one the planner always had (flags as 0/1, times in ms, tags and repeat as JSON text), so the logic that
// walks rows did not change.

import crypto from "node:crypto";

export const KINDS = ["alarm", "timer", "reminder", "todo", "note", "event", "task"];
export const STATES = ["open", "done", "cancelled"];

/**
 * The one name for a ring of an item at a moment: `planner-<item>-<due>`, due in epoch seconds. The
 * box's push uses it as its tag and each device as its local notification's id, so a ring heard
 * twice shows once (ADR 0029, R6).
 */
export const ringKey = (item, due) => `planner-${item}-${Math.floor(Number(due) / 1000)}`;
/** A ring key read back into { item, due (ms) }, or null. */
export const readKey = key => {
  const m = /^planner-(.+)-(\d{1,12})$/.exec(String(key ?? ""));
  return m ? { item: m[1], due: Number(m[2]) * 1000 } : null;
};

/** Short random ids for firings (the records give an item its own id). */
export const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;

/** A row as the tools show it: JSON parsed, flags as booleans. */
export function shape(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body ?? null, list: r.list ?? null, priority: r.priority, parent: r.parent ?? null,
    project: r.project ?? null, thread: r.thread ?? null, tags: safeJSON(r.tags, []), pinned: Boolean(r.pinned), state: r.state,
    at: r.at ?? null, tz: r.tz ?? null, floating: Boolean(r.floating), wall: r.wall ?? null, date: r.date ?? null,
    repeat: safeJSON(r.repeat, null), due: r.due ?? null, duration_ms: r.duration_ms ?? null, snooze_until: r.snooze_until ?? null,
    next_fire: r.next_fire ?? null, created: r.created, updated: r.updated, done_at: r.done_at ?? null, deleted_at: r.deleted_at ?? null,
    source: r.source ?? null, added_by: r.source_name ?? null, where: r.where_ ?? null,
    waits_on: r.waits_on ?? null, run_count: r.run_count ?? 0, last_result: r.last_result ?? null, paused: Boolean(r.paused),
    waits_on_fired: r.waits_on_fired ?? null,
  };
}
export const shapeFiring = f => f && ({ id: f.id, item: f.item, kind: f.kind, key: ringKey(f.item, f.due), due: f.due, ring: f.ring, missed: Boolean(f.missed), state: f.state,
  fired_at: f.fired_at, next_ring: f.next_ring ?? null, acked_at: f.acked_at ?? null, action: f.action ?? null, by: f.by ?? null, until: f.until ?? null });

function safeJSON(s, fallback) { try { return s == null ? fallback : JSON.parse(String(s)); } catch { return fallback; } }

/** The columns of a row (the planner's old item table, kept as the row shape). */
const COLUMNS = ["kind", "title", "body", "list", "priority", "parent", "project", "thread", "tags", "pinned", "state", "at", "tz", "floating",
  "wall", "date", "repeat", "due", "duration_ms", "snooze_until", "next_fire", "created", "updated", "done_at", "deleted_at", "source", "source_name", "where_",
  "waits_on", "run_count", "last_result", "paused", "waits_on_fired"];

/** Plain values for a row: objects as JSON, booleans as 0/1. */
const cell = (k, v) => v === undefined ? null : (k === "tags" || k === "repeat") ? (v == null ? (k === "tags" ? "[]" : null) : JSON.stringify(v))
  : typeof v === "boolean" ? (v ? 1 : 0) : v;

const iso = ms => (ms == null ? null : new Date(Number(ms)).toISOString());
const msOf = s => { if (s == null) return null; const t = Date.parse(String(s)); return Number.isNaN(t) ? null : t; };
const orNull = v => (v === undefined ? null : v);

// ---- Rows to records and back -------------------------------------------------------------------------

/** The record type a row of this kind lives in. */
export const typeOfKind = kind => (kind === "note" ? "note" : kind === "event" ? "event" : kind === "todo" ? "task" : "reminder");

const REMINDER_KEYS = { kind: "kind", title: "title", body: "body", state: "state", tz: "tz", wall: "wall", date: "date", duration_ms: "duration_ms", list: "list", priority: "priority",
  parent: "parent", project: "project", thread: "thread", source: "source", source_name: "added_by", waits_on: "waits_on", waits_on_fired: "waits_on_fired",
  run_count: "run_count", last_result: "last_result", tags: "tags", repeat: "repeat" };
const REMINDER_BOOL = { floating: "floating", pinned: "pinned", paused: "paused" };
const REMINDER_TIME = { at: "at", snooze_until: "snooze_until", next_fire: "next_fire", done_at: "done_at", deleted_at: "deleted_at" };
const NOTE_KEYS = { title: "title", body: "body", state: "state", list: "list", priority: "priority", parent: "parent", project: "project", thread: "thread", source: "source",
  source_name: "added_by", tags: "tags" };
const NOTE_BOOL = { pinned: "pinned" };
const NOTE_TIME = { done_at: "done_at", deleted_at: "deleted_at" };

/** One column of a row as a record field: [field, value], or null when the record has no such field. */
function toField(type, col, v) {
  const [keys, bools, times] = type === "note" ? [NOTE_KEYS, NOTE_BOOL, NOTE_TIME] : [REMINDER_KEYS, REMINDER_BOOL, REMINDER_TIME];
  if (col in times) return [times[col], v == null ? null : iso(v)];
  if (col in bools) return [bools[col], v == null ? null : Boolean(v)];
  if (col in keys) {
    // A repeat and tags are JSON text in the row and in the record alike. The planner's empty tags are not stored.
    if (col === "tags" && (v == null || v === "[]")) return [keys[col], null];
    return [keys[col], v == null ? null : v];
  }
  return null;
}
/** A reminder or note row as record data (every column that has a field and a value). */
export function rowToData(row) {
  const type = typeOfKind(row.kind);
  const data = {};
  for (const col of COLUMNS) {
    if (col === "created" || col === "updated") continue;
    const f = toField(type, col, row[col]);
    if (f && f[1] != null) data[f[0]] = f[1];
  }
  return data;
}
/** A record's data as a row of the planner's old shape. */
export function dataToRow(type, rec) {
  const d = rec.data || {};
  const note = type === "note";
  return {
    id: rec.id, kind: note ? "note" : d.kind || "reminder", title: d.title ?? "", body: orNull(d.body), list: orNull(d.list), priority: Number(d.priority) || 0, parent: orNull(d.parent),
    project: orNull(d.project), thread: orNull(d.thread), tags: d.tags ?? "[]", pinned: d.pinned ? 1 : 0, state: d.state || "open",
    at: note ? null : msOf(d.at), tz: note ? null : orNull(d.tz), floating: d.floating ? 1 : 0, wall: note ? null : orNull(d.wall), date: note ? null : orNull(d.date),
    repeat: note ? null : orNull(d.repeat), due: null, duration_ms: note ? null : orNull(d.duration_ms), snooze_until: note ? null : msOf(d.snooze_until),
    next_fire: note ? null : msOf(d.next_fire), created: rec.created_at, updated: rec.updated_at, done_at: msOf(d.done_at), deleted_at: msOf(d.deleted_at),
    source: orNull(d.source), source_name: orNull(d.added_by), where_: null, waits_on: note ? null : orNull(d.waits_on), run_count: Number(d.run_count) || 0,
    last_result: orNull(d.last_result), paused: d.paused ? 1 : 0, waits_on_fired: note ? null : orNull(d.waits_on_fired),
  };
}

/** The planner's own event as an Event record's data. An event is one start and an end; it has no repeat rule. */
export function eventToData(row) {
  const end = row.at != null && row.duration_ms ? row.at + row.duration_ms : null;
  return { title: row.title, starts_at: iso(row.at), ...(end != null ? { ends_at: iso(end) } : {}), all_day: false, ...(row.tz ? { time_zone: row.tz } : {}),
    ...(row.where_ ? { place: row.where_ } : {}), source: "vyre", ...(row.body ? { notes: row.body } : {}) };
}
/** An Event record the planner owns (source vyre) as a row of kind event. */
export function eventToRow(rec) {
  const d = rec.data || {};
  const at = msOf(d.starts_at), end = msOf(d.ends_at);
  return {
    id: rec.id, kind: "event", title: d.title ?? "", body: orNull(d.notes), list: null, priority: 0, parent: null, project: null, thread: null, tags: "[]", pinned: 0, state: "open",
    at, tz: orNull(d.time_zone), floating: 0, wall: null, date: null, repeat: null, due: null, duration_ms: end != null && at != null ? end - at : null, snooze_until: null,
    next_fire: null, created: rec.created_at, updated: rec.updated_at, done_at: null, deleted_at: null, source: "planner", source_name: null, where_: orNull(d.place),
    waits_on: null, run_count: 0, last_result: null, paused: 0, waits_on_fired: null,
  };
}

/** A kernel task as a todo row. What the planner knew of it (who added it, its priority, tags, list, project, thread) rides in the task's own `form`. */
export function taskToRow(t) {
  const m = (t.form && typeof t.form === "object" && t.form.planner) || {};
  const state = t.state === "done" ? "done" : t.state === "skipped" ? "cancelled" : "open";
  return {
    id: t.id, kind: "todo", title: t.title, body: orNull(t.note), list: orNull(m.list), priority: Number(m.priority) || 0, parent: orNull(m.parent), project: orNull(m.project),
    thread: orNull(m.thread), tags: m.tags ? JSON.stringify(m.tags) : "[]", pinned: m.pinned ? 1 : 0, state,
    at: null, tz: null, floating: 0, wall: null, date: t.due && /^\d{4}-\d{2}-\d{2}/.test(String(t.due)) ? String(t.due).slice(0, 10) : null, repeat: null,
    due: t.due ? String(t.due).slice(0, 10) : null, duration_ms: null, snooze_until: null, next_fire: null, created: t.created_at, updated: t.updated_at,
    done_at: state === "done" ? t.updated_at : null, deleted_at: null, source: orNull(m.source), source_name: orNull(m.added_by), where_: null,
    waits_on: null, run_count: 0, last_result: null, paused: 0, waits_on_fired: null,
  };
}

/** A connected calendar's event, as a cache row (the shape calendar.js has always worked with). */
export function calToRow(rec) {
  const d = rec.data || {};
  return { id: rec.id, account: d.calendar || "", event_id: d.external_id || "", title: d.title ?? "", start: msOf(d.starts_at), end: msOf(d.ends_at), all_day: d.all_day ? 1 : 0,
    where_: orNull(d.place), url: typeof d.notes === "string" && /^https?:\/\/\S+$/.test(d.notes) ? d.notes : null, synced_at: rec.updated_at, next_fire: null, rung_start: null, snooze_until: null };
}
export function calToData(row) {
  return { title: row.title ?? "", starts_at: iso(row.start), ...(row.end != null ? { ends_at: iso(row.end) } : {}), all_day: Boolean(row.all_day), source: "google",
    calendar: String(row.account), external_id: String(row.event_id), ...(row.where_ ? { place: row.where_ } : {}),
    // The Event type has no field for the link back to the calendar's own page, so it rides in the notes (nothing else writes notes on an event this planner copied).
    ...(row.url ? { notes: String(row.url) } : {}) };
}

// ---- The store -------------------------------------------------------------------------------------------

const PAGE = 200;
const RING_KEEP_MS = 30 * 86_400_000;
const refuse = (message, code) => Object.assign(new Error(message), { code });

/**
 * The planner's store over the Space's records.
 * @param {{ K: any, log: (m: string) => void, now?: () => number, onExternal?: (kind: string, id: string) => void }} o
 *   K is ctx.kernel (a first-party module's handle). Every call runs under the module's own service chain.
 */
export function store({ K, log, now = Date.now, onExternal = () => {} }) {
  if (!K || typeof K.serviceChain !== "function" || !K.records) throw refuse("the planner keeps its things in the Space's records, and the kernel is not on", "unavailable");
  const chain = () => K.serviceChain();
  /** @type {Map<string, any>} */ const items = new Map();
  /** @type {Map<string, any>} */ const firings = new Map();
  /** @type {Map<string, any>} */ const cal = new Map();
  /** @type {Map<string, any>} */ const settings = new Map();
  /** The record each thing is kept in: key `<type>:<id>` to { version, rid } (a firing and a setting have their own planner id). @type {Map<string, any>} */
  const meta = new Map();
  const mkey = (type, id) => `${type}:${id}`;

  // ---- writes, in order, behind the rows ----
  let queue = Promise.resolve();
  let failures = 0;
  const enqueue = fn => { queue = queue.then(fn).catch(e => { failures++; log(`planner: a record was not written (${/** @type {Error} */ (e).code || ""} ${/** @type {Error} */ (e).message})`); }); return queue; };
  const write = {
    async create(type, id, data) {
      const rec = await K.records.create(chain(), type, data);
      meta.set(mkey(type, id), { version: rec.version, rid: rec.id });
      return rec;
    },
    async update(type, id, data) {
      const m = meta.get(mkey(type, id));
      if (!m) throw refuse(`no record for ${type} ${id}`, "not_found");
      for (let attempt = 0; ; attempt++) {
        try {
          const rec = await K.records.update(chain(), type, m.rid, data, m.version);
          m.version = rec.version;
          return rec;
        } catch (e) {
          if (attempt || !e || /** @type {any} */ (e).code !== "version_conflict") throw e;
          const cur = await K.records.get(chain(), type, m.rid);
          m.version = cur.version;
        }
      }
    },
    async remove(type, id) {
      const m = meta.get(mkey(type, id));
      if (!m) return;
      await K.records.remove(chain(), type, m.rid, m.version);
      meta.delete(mkey(type, id));
    },
  };
  const flush = async () => { await queue; };

  // ---- loading ----
  /** Every row of a type, a page at a time. */
  async function everyRecord(type, filter) {
    const out = [];
    let cursor;
    for (let n = 0; n < 500; n++) {
      const page = await K.records.query(chain(), type, { ...(filter ? { filter } : {}), page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
      out.push(...page.rows);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }
  const hold = (type, rec) => meta.set(mkey(type, rec.id), { version: rec.version, rid: rec.id });

  async function loadReminders() {
    for (const type of ["reminder", "note"]) {
      for (const rec of await everyRecord(type)) { hold(type, rec); const row = dataToRow(type, rec); items.set(row.id, row); }
    }
  }
  async function loadEvents(fromMs) {
    const recs = await everyRecord("event", { field: "starts_at", op: "gte", value: iso(fromMs) });
    for (const rec of recs) {
      hold("event", rec);
      if ((rec.data || {}).source === "google") { const row = calToRow(rec); const old = cal.get(row.id); cal.set(row.id, old ? { ...row, next_fire: old.next_fire, rung_start: old.rung_start, snooze_until: old.snooze_until } : row); }
      else { const row = eventToRow(rec); items.set(row.id, row); }
    }
  }
  async function loadRings() {
    const cut = now() - RING_KEEP_MS;
    for (const rec of await everyRecord("planner-ring")) {
      const d = rec.data || {};
      if (!d.ref) continue;
      meta.set(mkey("planner-ring", d.ref), { version: rec.version, rid: rec.id });
      const f = { id: d.ref, item: d.item, kind: d.kind || "", due: Number(d.due), ring: Number(d.ring) || 0, missed: d.missed ? 1 : 0, state: d.state, fired_at: Number(d.fired_at) || 0,
        next_ring: d.next_ring ?? null, acked_at: d.acked_at ?? null, action: d.action ?? null, by: d.by ?? null, until: d.until ?? null };
      if (f.fired_at < cut && f.state !== "ringing") { enqueue(() => write.remove("planner-ring", f.id)); continue; }
      firings.set(f.id, f);
    }
  }
  async function loadSettings() {
    for (const rec of await everyRecord("planner-state")) {
      const d = rec.data || {};
      if (!d.key) continue;
      meta.set(mkey("planner-state", d.key), { version: rec.version, rid: rec.id });
      try { settings.set(d.key, JSON.parse(d.value)); } catch { /* an unreadable setting is as if it were not set */ }
    }
  }
  async function loadTodos() {
    if (!K.tasks || typeof K.tasks.list !== "function") return;
    const list = await K.tasks.list(chain(), { doer: K.owner });
    const seen = new Set();
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || t.output?.kind !== "note" || !(t.form && t.form.planner)) continue;
      const row = taskToRow(t);
      seen.add(row.id);
      items.set(row.id, row);
    }
    for (const [id, r] of items) if (r.kind === "todo" && !seen.has(id)) items.delete(id);
  }

  /** Read everything the planner keeps into the rows. */
  async function load(fromMs = now() - 86_400_000) {
    await loadSettings();
    await loadReminders();
    await loadEvents(fromMs);
    await loadRings();
    await loadTodos();
  }

  // ---- reads ----
  const api = {
    flush, load, loadTodos, failures: () => failures,
    /** The settings, kept as one record per key. */
    state: {
      get: (k, fallback = undefined) => (settings.has(k) ? settings.get(k) : fallback),
      set(k, v) {
        const had = settings.has(k) || meta.has(mkey("planner-state", k));
        settings.set(k, v);
        const data = { key: k, value: JSON.stringify(v) };
        enqueue(async () => { if (had && meta.has(mkey("planner-state", k))) await write.update("planner-state", k, data); else await write.create("planner-state", k, data); });
      },
    },
    /** @returns {any} */
    item: id => items.get(String(id)),
    /** @returns {any} */
    firing: id => firings.get(String(id)),
    /** The newest firing of an item for one due moment, whatever its state. @returns {any} */
    firingAt(item, due) {
      let best;
      for (const f of firings.values()) if (f.item === String(item) && f.due === Number(due) && (!best || f.fired_at >= best.fired_at)) best = f;
      return best;
    },
    /** Add an item and give it its id: the record's own (a todo's is its task's). @returns {Promise<string>} */
    async insert(row) {
      const full = Object.fromEntries(COLUMNS.filter(k => row[k] !== undefined).map(k => [k, cell(k, row[k])]));
      const type = typeOfKind(full.kind);
      let id;
      if (type === "task") {
        const form = { planner: { source: full.source ?? null, added_by: full.source_name ?? null, ...(full.priority ? { priority: full.priority } : {}), ...(full.list ? { list: full.list } : {}),
          ...(full.project ? { project: full.project } : {}), ...(full.thread ? { thread: full.thread } : {}), ...(full.parent ? { parent: full.parent } : {}),
          ...(full.pinned ? { pinned: true } : {}), ...(full.tags && full.tags !== "[]" ? { tags: JSON.parse(full.tags) } : {}) } };
        const t = await K.tasks.request(chain(), { title: full.title, doer: { kind: "person", id: K.owner, space: K.space }, output: { kind: "note" }, ...(full.due ? { due: full.due } : {}),
          ...(full.body ? { note: String(full.body).slice(0, 400) } : {}), form });
        id = t.id;
        items.set(id, { ...taskToRow(t), source: full.source ?? null, source_name: full.source_name ?? null });
        return id;
      }
      const data = type === "event" ? eventToData(full) : rowToData(full);
      const rec = await K.records.create(chain(), type, data);
      id = rec.id;
      hold(type, rec);
      items.set(id, { id, ...Object.fromEntries(COLUMNS.map(k => [k, full[k] ?? null])), created: full.created ?? rec.created_at, updated: full.updated ?? rec.updated_at });
      return id;
    },
    /** Change some columns of an item: the row now, its record behind. */
    patch(id, fields) {
      const row = items.get(String(id));
      if (!row) return;
      const keys = Object.keys(fields).filter(k => COLUMNS.includes(k));
      if (!keys.length) return;
      for (const k of keys) row[k] = cell(k, fields[k]);
      const type = typeOfKind(row.kind);
      if (type === "task") return; // a task is moved by its own acts (see doneTodo, skipTodo), not edited
      if (type === "event") { if (row.deleted_at != null) return; const data = eventToData(row); enqueue(() => write.update("event", id, data)); return; }
      const data = {};
      for (const k of keys) { if (k === "created" || k === "updated") continue; const f = toField(type, k, row[k]); if (f) data[f[0]] = f[1]; }
      if (Object.keys(data).length) enqueue(() => write.update(type, id, data));
    },
    /** @returns {any[]} */
    list({ kind, state: st = "open", list, project, pinned, tag, limit = 100, deleted = false } = {}) {
      let rows = [...items.values()].filter(r => (deleted ? r.deleted_at != null : r.deleted_at == null));
      if (kind) rows = rows.filter(r => r.kind === kind);
      if (st && st !== "all") rows = rows.filter(r => r.state === st);
      if (list) rows = rows.filter(r => r.list === list);
      if (project) rows = rows.filter(r => r.project === project);
      if (pinned !== undefined) rows = rows.filter(r => Boolean(r.pinned) === Boolean(pinned));
      if (tag) rows = rows.filter(r => safeJSON(r.tags, []).includes(tag));
      const when = r => (r.next_fire ?? r.at);
      // pinned first, then by time (items with none last), then priority, then newest
      return rows.sort((a, b) => (b.pinned - a.pinned) || (when(a) == null) - (when(b) == null) || (when(a) ?? 0) - (when(b) ?? 0) || (b.priority - a.priority) || (b.created - a.created)).slice(0, limit);
    },
    /** Every row a scan may need (the scheduler, the agenda). @returns {any[]} */
    all: () => [...items.values()],
    /** A todo done or skipped is the person's own act on the kernel's task. */
    async finishTodo(id, chainOf, how = "done") {
      const row = items.get(String(id));
      if (!row || row.kind !== "todo") throw refuse("no such todo", "not_found");
      const c = chainOf;
      if (how === "done") {
        const cur = await K.tasks.get(c, row.id);
        if (cur && cur.state === "ready") await K.tasks.start(c, row.id);
        const t = await K.tasks.complete(c, row.id, { note: "done in the planner", sources: [`planner:${row.id}`] });
        Object.assign(row, taskToRow(t), { source: row.source, source_name: row.source_name });
      } else {
        const t = await K.tasks.skip(c, row.id, "dropped in the planner");
        Object.assign(row, taskToRow(t), { source: row.source, source_name: row.source_name });
      }
      return row;
    },
    insertFiring(f) {
      const row = { id: f.id, item: f.item, kind: f.kind, due: f.due, ring: f.ring, missed: f.missed ? 1 : 0, state: f.state, fired_at: f.fired_at, next_ring: f.next_ring ?? null,
        acked_at: null, action: null, by: null, until: null };
      firings.set(row.id, row);
      const data = { ref: row.id, item: row.item, kind: row.kind, due: row.due, ring: row.ring, missed: Boolean(row.missed), state: row.state, fired_at: row.fired_at,
        ...(row.next_ring != null ? { next_ring: row.next_ring } : {}) };
      enqueue(() => write.create("planner-ring", row.id, data));
    },
    patchFiring(id, fields) {
      const f = firings.get(String(id));
      if (!f) return;
      Object.assign(f, Object.fromEntries(Object.keys(fields).map(k => [k, fields[k] ?? null])));
      const data = {};
      for (const k of Object.keys(fields)) data[k] = k === "missed" ? Boolean(fields[k]) : fields[k] ?? null;
      enqueue(() => write.update("planner-ring", id, data));
    },
    /** The item's firing still ringing, if any. @returns {any} */
    ringing(item) {
      let best;
      for (const f of firings.values()) if (f.item === String(item) && f.state === "ringing" && (!best || f.fired_at >= best.fired_at)) best = f;
      return best;
    },
    /** Every firing still ringing, oldest first. @returns {any[]} */
    allRinging: () => [...firings.values()].filter(f => f.state === "ringing").sort((a, b) => a.fired_at - b.fired_at),
    /** @returns {any[]} */
    firingsOf: (item, limit = 10) => [...firings.values()].filter(f => f.item === String(item)).sort((a, b) => b.fired_at - a.fired_at).slice(0, limit),
    /** Firings still ringing with a time to ring again, and ones an item's moment has passed: for the scheduler. */
    ringsDue: at => [...firings.values()].filter(f => f.state === "ringing" && f.next_ring != null && f.next_ring <= at),
    /** The earliest moment any item, snooze or firing waits for. */
    earliest() {
      let at = null;
      const lo = x => { if (x != null && (at == null || x < at)) at = x; };
      for (const r of items.values()) if (r.kind !== "todo" && r.state === "open" && r.deleted_at == null) { lo(r.next_fire); lo(r.snooze_until); }
      for (const f of firings.values()) if (f.state === "ringing") lo(f.next_ring);
      return at;
    },
    /** Items due now (a ring time or a snooze that has come), in the order they are due. @returns {any[]} */
    itemsDue(at) {
      return [...items.values()].filter(r => r.kind !== "todo" && r.state === "open" && r.deleted_at == null && ((r.next_fire != null && r.next_fire <= at) || (r.snooze_until != null && r.snooze_until <= at)))
        .sort((a, b) => (a.snooze_until ?? a.next_fire) - (b.snooze_until ?? b.next_fire));
    },
    /** Supersede the ring still going for an item (a new ring replaces one still ringing). */
    supersede(item) {
      for (const f of firings.values()) if (f.item === String(item) && f.state === "ringing") api.patchFiring(f.id, { state: "superseded", next_ring: null });
    },
    /** An event's record is removed (an event has no field for being deleted); the row stays, marked, so a restore can bring it back. */
    removeEvent(id) { const type = "event"; enqueue(() => write.remove(type, String(id))); },
    /** Bring a removed event's record back. */
    async restoreEvent(id) {
      await flush();
      await K.records.restore(chain(), "event", String(id));
      const rec = await K.records.get(chain(), "event", String(id));
      hold("event", rec);
    },
    /** Items soft-deleted more than 30 days ago go for good, with their firings. */
    purge(at) {
      const cut = at - 30 * 86_400_000;
      for (const r of [...items.values()]) {
        if (r.deleted_at == null || r.deleted_at >= cut || r.kind === "todo") continue;
        for (const f of [...firings.values()]) if (f.item === r.id) { firings.delete(f.id); enqueue(() => write.remove("planner-ring", f.id)); }
        items.delete(r.id);
        const type = typeOfKind(r.kind);
        enqueue(() => write.remove(type, r.id));
      }
    },
    // ---- the connected calendars' events (calendar.js) ----
    cal: {
      /** @returns {any} */ row: id => cal.get(String(id)),
      rows: () => [...cal.values()],
      ofAccount: account => [...cal.values()].filter(r => r.account === account),
      accounts: () => [...new Set([...cal.values()].map(r => r.account))],
      async insert(row) {
        const rec = await K.records.create(chain(), "event", calToData(row));
        hold("event", rec);
        cal.set(rec.id, { ...row, id: rec.id });
        return rec.id;
      },
      patch(id, fields) {
        const r = cal.get(String(id));
        if (!r) return;
        Object.assign(r, fields);
        // The ring's own state (next_fire, rung_start, snooze_until) is the planner's; the record keeps what the calendar says.
        const keys = Object.keys(fields).filter(k => ["title", "start", "end", "all_day", "where_", "url"].includes(k));
        if (keys.length) { const data = calToData(r); enqueue(() => write.update("event", id, data)); }
      },
      drop(id) { cal.delete(String(id)); enqueue(() => write.remove("event", String(id))); },
    },
    // ---- records changed by someone else ----
    /** Read a record back into the rows when its version is newer than what the store holds. */
    async refresh(type, id) {
      const m = meta.get(mkey(type, id));
      let rec;
      try { rec = await K.records.get(chain(), type, id); } catch { rec = null; }
      if (!rec) {
        // A row the planner itself marked deleted stays (an event's record is removed then, and a restore brings it back).
        const row = items.get(id);
        if (row && row.deleted_at != null) { meta.delete(mkey(type, id)); return; }
        if (type === "event") { cal.delete(id); items.delete(id); } else if (type === "reminder" || type === "note") items.delete(id);
        meta.delete(mkey(type, id));
        onExternal(type, id);
        return;
      }
      if (m && m.version >= rec.version) return;
      hold(type, rec);
      if (type === "reminder" || type === "note") items.set(id, dataToRow(type, rec));
      else if (type === "event") {
        if ((rec.data || {}).source === "google") { const row = calToRow(rec); const old = cal.get(id); cal.set(id, old ? { ...row, next_fire: old.next_fire, rung_start: old.rung_start, snooze_until: old.snooze_until } : row); }
        else items.set(id, eventToRow(rec));
      }
      onExternal(type, id);
    },
    /** The record types the store keeps rows for, for a subscription. */
    types: ["reminder", "note", "event"],
  };
  return api;
}
