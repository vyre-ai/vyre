// @ts-check
// The planner's data, held in the Space's records (no tables of its own). One working set in memory, the engine's view, written through to the gateway:
//   reminders (alarms, timers, reminders, /later tasks)  -> `reminder` records        notes -> `note` records
//   to-dos                                                -> the kernel's Tasks, assigned to the person
//   events (the planner's own and every connector's)      -> `event` records (source "vyre" for the planner's own)
//   rings and settings                                    -> `planner_firing` and `planner_state` records
// The scheduler reads the working set, so ringing stays synchronous and exact on a fake clock; every change is queued to the gateway in order and `flush()` waits for it.
// A record changed from outside (the app, a Flow, a connector) arrives as a kernel event and is read back in, so the records stay the truth and the planner follows them.
import { newId } from "./items.js";
import { occurrences, parseRule } from "./rrule.js";
import { validZone } from "./time.js";

const DAY = 86_400_000;
const FIRING_KEEP = 60 * DAY;
const iso = (/** @type {any} */ ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const ms = (/** @type {any} */ v) => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(n) ? n : null; };
const json = (/** @type {any} */ s, /** @type {any} */ fallback) => { try { return s == null ? fallback : JSON.parse(String(s)); } catch { return fallback; } };

/** One column's value as the working set holds it (what SQLite held before): JSON as text, booleans as 0 and 1. */
const cell = (/** @type {string} */ k, /** @type {any} */ v) => (v === undefined ? null : (k === "tags" || k === "repeat") ? (v == null ? (k === "tags" ? "[]" : null) : typeof v === "string" ? v : JSON.stringify(v)) : typeof v === "boolean" ? (v ? 1 : 0) : v);
const norm = (/** @type {any} */ o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cell(k, v)]));

/** The type a row is kept as. */
export const typeOf = (/** @type {{ kind: string }} */ row) => (row.kind === "note" ? "note" : row.kind === "todo" ? "task" : "reminder");

/** A planner row (the engine's shape) as a record's data. */
export function toData(/** @type {any} */ r) {
  const d = {
    title: r.title, state: r.state, body: r.body ?? null, list: r.list ?? null, priority: r.priority ?? 0, pinned: Boolean(r.pinned), tags: typeof r.tags === "string" ? r.tags : JSON.stringify(r.tags || []),
    project: r.project ?? null, thread: r.thread ?? null, source: r.source ?? null, added_by: r.source_name ?? null, created: r.created, updated: r.updated,
    removed_at: iso(r.deleted_at), done_at: iso(r.done_at),
  };
  if (r.kind === "note") return d;
  return { ...d, kind: r.kind, at: iso(r.at), tz: r.tz ?? null, floating: Boolean(r.floating), wall: r.wall ?? null, date: r.date ?? null, repeat: r.repeat == null ? null : typeof r.repeat === "string" ? r.repeat : JSON.stringify(r.repeat),
    duration_ms: r.duration_ms ?? null, snooze_until: iso(r.snooze_until), next_fire: r.next_fire ?? null, waits_on: r.waits_on ?? null, run_count: r.run_count ?? 0, last_result: r.last_result ?? null,
    paused: Boolean(r.paused), waits_on_fired: r.waits_on_fired ?? null };
}

/** A reminder or note record as a planner row. */
export function fromRecord(/** @type {any} */ rec, /** @type {"reminder"|"note"} */ type) {
  const d = rec.data || {};
  return {
    id: rec.id, kind: type === "note" ? "note" : d.kind, title: d.title ?? "", body: d.body ?? null, list: d.list ?? null, priority: d.priority ?? 0, parent: null, project: d.project ?? null, thread: d.thread ?? null,
    tags: typeof d.tags === "string" ? d.tags : "[]", pinned: d.pinned ? 1 : 0, state: d.state ?? "open", at: ms(d.at), tz: d.tz ?? null, floating: d.floating ? 1 : 0, wall: d.wall ?? null, date: d.date ?? null,
    repeat: d.repeat ?? null, due: null, duration_ms: d.duration_ms ?? null, snooze_until: ms(d.snooze_until), next_fire: d.next_fire ?? null, created: d.created ?? 0, updated: d.updated ?? 0,
    done_at: ms(d.done_at), deleted_at: ms(d.removed_at), source: d.source ?? null, source_name: d.added_by ?? null, where_: null, waits_on: d.waits_on ?? null, run_count: d.run_count ?? 0,
    last_result: d.last_result ?? null, paused: d.paused ? 1 : 0, waits_on_fired: d.waits_on_fired ?? null,
  };
}

/** A to-do's extras (what a Task has no field for) ride in the Task's `form`, which is plain data. */
const TODO_FORM = ["list", "priority", "pinned", "tags", "project", "thread", "tz", "floating", "wall", "date", "repeat", "deleted_at", "source", "source_name", "created"];

/** A Task made by the planner as a planner row, or null for any other Task. */
export function fromTask(/** @type {any} */ t) {
  const p = t.form && t.form.planner;
  if (!p) return null;
  const state = t.state === "done" ? "done" : t.state === "skipped" ? "cancelled" : "open";
  const timed = Boolean(p.wall);
  return { id: t.id, kind: "todo", title: t.title, body: t.note ?? null, list: p.list ?? null, priority: p.priority ?? 0, parent: t.parent ?? null, assignee: t.doer && t.doer.kind === "agent" ? t.doer.id : null, project: p.project ?? null, thread: p.thread ?? null,
    tags: typeof p.tags === "string" ? p.tags : "[]", pinned: p.pinned ? 1 : 0, state, at: timed && t.due != null ? t.due : null, tz: p.tz ?? null, floating: p.floating ? 1 : 0, wall: p.wall ?? null,
    date: p.date ?? null, repeat: typeof p.repeat === "string" ? p.repeat : null, due: p.date ?? null, duration_ms: null, snooze_until: null, next_fire: null, created: p.created ?? t.created_at, updated: t.updated_at, done_at: state === "open" ? null : t.updated_at,
    deleted_at: p.deleted_at ?? null, source: p.source ?? null, source_name: p.source_name ?? null, where_: null, waits_on: null, run_count: 0, last_result: null, paused: 0, waits_on_fired: null, _task: true };
}

/** A to-do row as the Task it is made as. */
export function toTaskSpec(/** @type {any} */ r, /** @type {{ kind: string, id: string, space: string }} */ doer) {
  return { title: r.title, doer, output: { kind: "note" }, source: "manual", ...(r.at != null ? { due: r.at } : {}), ...(r.body ? { note: String(r.body).slice(0, 400) } : {}), ...(r.parent ? { parent: r.parent } : {}), form: { planner: formOf(r) } };
}

/** What a Task has no field for, as the Task's form carries it. */
export const formOf = (/** @type {any} */ r) => Object.fromEntries(TODO_FORM.map(k => [k, k === "tags" ? (typeof r.tags === "string" ? r.tags : JSON.stringify(r.tags || [])) : r[k] ?? null]));

/** The Task's `edit` for a to-do row's changed fields: words, note, due and the whole form (it is small and replaced whole). @param {any} r @param {string[]} keys */
export function taskEdit(r, keys) {
  /** @type {any} */ const p = {};
  if (keys.includes("title")) p.title = r.title;
  if (keys.includes("body")) p.note = r.body ? String(r.body).slice(0, 400) : null;
  if (keys.includes("at") || keys.includes("wall")) p.due = r.at ?? null;
  if (keys.includes("parent")) p.parent = r.parent ?? null;
  if (keys.some(k => TODO_FORM.includes(k) && k !== "created")) p.form = { planner: formOf(r) };
  return p;
}

/** An Event record as a calendar row. A repeating event is one record with its `rrule`; `expandRow` makes its occurrences. */
export function fromEvent(/** @type {any} */ rec, /** @type {number} */ synced) {
  const d = rec.data || {};
  const start = ms(d.starts_at);
  if (start == null) return null;
  return { id: rec.id, rec: rec.id, account: d.source === "vyre" ? null : d.calendar ?? null, event_id: d.external_id ?? rec.id, title: d.title ?? "", start, end: ms(d.ends_at), all_day: d.all_day ? 1 : 0, where_: d.place ?? null,
    url: d.url ?? null, rrule: d.rrule || null, zone: d.time_zone ?? null, synced_at: synced, next_fire: null, rung_start: null, snooze_until: null, own: d.source === "vyre", project: null, thread: null };
}

/** The record an event row (or one of a repeating event's occurrences, `<record>~<start>`) belongs to. */
export const recordOf = (/** @type {any} */ id) => String(id).split("~")[0];

/**
 * The rows an event row stands for between from and to: itself, or one row per occurrence of its rule (id `<record>~<start>`, so each rings and is answered on its own).
 * A rule that cannot be read leaves the event as a single one. @param {any} row @param {number} from @param {number} to @param {string} [zone] the planner's zone, for an event with none of its own
 */
export function expandRow(row, from, to, zone = "UTC") {
  if (!row.rrule) return row.start < to && (row.end ?? row.start) >= from ? [row] : [];
  let rule;
  try { rule = parseRule(row.rrule); } catch { return row.start < to && (row.end ?? row.start) >= from ? [{ ...row, rrule: null }] : []; }
  const tz = row.zone && validZone(row.zone) ? row.zone : zone;
  const span = row.end != null ? row.end - row.start : null;
  return occurrences({ rule, start: row.start, tz, from: from - (span ?? 0), to }).map(s => ({ ...row, id: `${row.rec}~${s}`, start: s, end: span != null ? s + span : null, occ: true }));
}

/**
 * @param {{ K: any, now: () => number, log: (m: string) => void, onExternal?: (row: any, how: "added"|"changed"|"removed") => void, onEvents?: () => void, zone?: () => string }} o
 */
export async function openRecords(o) {
  const { K, now, log } = o;
  const chain = () => K.serviceChain();
  const space = K.space;
  const owner = () => K.owner;
  /** @type {Map<string, any>} */ const items = new Map();
  /** @type {Map<string, any>} */ const firings = new Map();
  /** @type {Map<string, any>} */ const cal = new Map();
  /** @type {Map<string, { rid: string | null, version: number | null }>} firing id and settings key -> the record behind it */ const refs = new Map();
  /** @type {Map<string, number>} the version we last wrote or read, by record id, so our own events are not read back as outside changes */ const known = new Map();
  /** @type {Map<string, any>} */ const settings = new Map();
  const stateRefs = new Map();
  /** @type {Map<string, number>} writes queued and not yet done, by item: a change event that arrives meanwhile is ours and older than the working set */ const writing = new Map();
  const busy = (/** @type {string} */ id, /** @type {number} */ d) => writing.set(id, Math.max(0, (writing.get(id) || 0) + d));

  // ---- Writes, in order -----------------------------------------------------------------------
  let queue = Promise.resolve();
  /** @type {Error | null} */ let failed = null;
  const enqueue = (/** @type {() => Promise<any>} */ fn, /** @type {string} */ what = "") => {
    const p = queue.then(fn);
    queue = p.catch(e => { failed ||= e; log(`planner: a change was not saved${what ? ` (${what})` : ""} (${e && e.message})`); });
    return p.catch(() => {});
  };
  /** Wait for every queued write; the first failure since the last flush is thrown once. */
  async function flush() {
    await queue;
    if (failed) { const e = failed; failed = null; throw e; }
  }

  /** Update a record, retrying once on a stale version (the app edited it meanwhile): our fields win on top of what is there. */
  async function updateRecord(/** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch, /** @type {{ version: number | null }} */ ref) {
    const run = async (/** @type {number} */ v) => K.records.update(chain(), type, id, patch, v);
    let rec;
    try { rec = await run(ref.version ?? 0); }
    catch (e) {
      if (!e || /** @type {any} */ (e).code !== "version_conflict") throw e;
      const cur = await K.records.get(chain(), type, id);
      if (!cur) return null;
      rec = await run(cur.version);
    }
    ref.version = rec.version; known.set(id, rec.version);
    return rec;
  }

  // ---- Loading ---------------------------------------------------------------------------------
  async function pages(/** @type {string} */ type, /** @type {any} */ spec = {}, /** @type {any} */ as = chain()) {
    const out = [];
    let cursor;
    for (let i = 0; i < 500; i++) {
      const r = await K.records.query(as, type, { ...spec, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      out.push(...r.rows);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return out;
  }
  const versions = new Map();
  async function load() {
    for (const rec of await pages("reminder")) { items.set(rec.id, fromRecord(rec, "reminder")); versions.set(rec.id, rec.version); known.set(rec.id, rec.version); }
    for (const rec of await pages("note")) { items.set(rec.id, fromRecord(rec, "note")); known.set(rec.id, rec.version); versions.set(rec.id, rec.version); }
    const tasks = K.tasks && K.tasks.list ? await K.tasks.list(chain(), { doer: owner() }).catch(() => []) : [];
    for (const t of tasks) { const r = fromTask(t); if (r) items.set(r.id, r); }
    for (const rec of await pages("planner_firing")) {
      const f = { id: rec.data.fid, item: rec.data.item, kind: rec.data.kind, due: rec.data.due, ring: rec.data.ring ?? 1, missed: rec.data.missed ? 1 : 0, state: rec.data.state, fired_at: rec.data.fired_at ?? 0,
        next_ring: rec.data.next_ring ?? null, acked_at: rec.data.acked_at ?? null, action: rec.data.action ?? null, by: rec.data.by ?? null, until: rec.data.until ?? null };
      firings.set(f.id, f); refs.set(f.id, { rid: rec.id, version: rec.version });
    }
    for (const rec of await pages("planner_state")) { settings.set(rec.data.key, json(rec.data.value, null)); stateRefs.set(rec.data.key, { rid: rec.id, version: rec.version }); }
  }

  // ---- Calendar (Event records) -----------------------------------------------------------------
  const eventSpec = (/** @type {number} */ from, /** @type {number} */ to) => ({ filter: { and: [{ field: "starts_at", op: "lt", value: iso(to) }, { field: "starts_at", op: "gte", value: iso(from - 40 * DAY) }] } });
  // The Event type is the Space's shared one (defined once for every Space); a Space that has none yet has no events.
  const unknownTypeIsEmpty = (/** @type {any} */ e) => { if (e && e.code === "unknown_type") return []; throw e; };
  /** Every event row that starts in [from, to) or began a while before and is still going, and each occurrence of a repeating event: read straight from the records, for an agenda. */
  async function eventsBetween(/** @type {number} */ from, /** @type {number} */ to) {
    /** @type {Map<string, any>} */ const recs = new Map();
    for (const r of await pages("event", eventSpec(from, to)).catch(unknownTypeIsEmpty)) recs.set(r.id, r);
    // A repeating event may have begun long ago: it is found by its rule, not by its first start.
    for (const r of await pages("event", { filter: { and: [{ not: { field: "rrule", op: "is_null" } }, { field: "starts_at", op: "lt", value: iso(to) }] } }).catch(unknownTypeIsEmpty)) recs.set(r.id, r);
    const zone = o.zone ? o.zone() : "UTC";
    return [...recs.values()].map(r => fromEvent(r, now())).filter(Boolean).flatMap(r => expandRow(r, from, to, zone));
  }
  /** Refresh the working set of events the planner will ring for: a day back to 14 days ahead. @returns {Promise<{ added: number, changed: number, removed: number, events: number }>} */
  async function loadEvents(/** @type {(row: any, old: any) => any} */ settle) {
    const t = now();
    const rows = await eventsBetween(t - DAY, t + 14 * DAY);
    const seen = new Set();
    let added = 0, changed = 0, removed = 0;
    for (const r of rows) {
      seen.add(r.id);
      const old = cal.get(r.id);
      const next = settle(r, old);
      if (!old) added++; else if (old.title !== r.title || old.start !== r.start || old.end !== r.end || old.where_ !== r.where_) changed++;
      cal.set(r.id, next);
    }
    for (const id of [...cal.keys()]) if (!seen.has(id)) { const c = cal.get(id); if (c && c.start >= t - DAY && c.start <= t + 14 * DAY) { cal.delete(id); removed++; } else if (c && (c.start < t - DAY || c.start > t + 14 * DAY)) cal.delete(id); }
    return { added, changed, removed, events: rows.length };
  }

  // ---- The store the planner reads -------------------------------------------------------------
  return {
    owner, space, load, flush, enqueue, loadEvents, eventsBetween,
    state: {
      get: (/** @type {string} */ k, fallback = undefined) => (settings.has(k) ? settings.get(k) : fallback),
      set(/** @type {string} */ k, /** @type {any} */ v) {
        settings.set(k, v);
        void enqueue(async () => {
          const ref = stateRefs.get(k);
          if (ref) { const rec = await K.records.update(chain(), "planner_state", ref.rid, { value: JSON.stringify(v) }, ref.version); ref.version = rec.version; }
          else { const rec = await K.records.create(chain(), "planner_state", { key: k, value: JSON.stringify(v) }); stateRefs.set(k, { rid: rec.id, version: rec.version }); }
        });
      },
    },
    /** @returns {any} */ item: (/** @type {string} */ id) => items.get(String(id)),
    cal: {
      rows: () => [...cal.values()],
      row: (/** @type {string} */ id) => cal.get(String(id)),
      put: (/** @type {any} */ r) => { cal.set(r.id, r); },
      drop: (/** @type {string} */ id) => { cal.delete(String(id)); },
      patch: (/** @type {string} */ id, /** @type {any} */ f) => { const r = cal.get(String(id)); if (r) Object.assign(r, f); },
      /** An event of the planner's own: the record, and its calendar row. */
      async create(/** @type {any} */ data, /** @type {any} */ onBehalf = undefined) {
        // The person the event is for (their own chain, when a person added it) is named so the Bin lists it to them; calendar sync has no person and leaves it to the owner.
        const rec = await K.records.create(chain(), "event", data, onBehalf ? { on_behalf: onBehalf } : {});
        known.set(rec.id, rec.version);
        return fromEvent(rec, now());
      },
      async update(/** @type {string} */ id, /** @type {any} */ patch) { const rec = await updateRecord("event", id, patch, { version: null }); return rec ? fromEvent(rec, now()) : null; },
      /** Move an event's record to the bin (the records' own remove): it can come back with `restore`, after a restart too. @returns {Promise<boolean>} false when there is no such record */
      async remove(/** @type {string} */ id) {
        const cur = await K.records.get(chain(), "event", id).catch(() => null);
        if (!cur) return false;
        await K.records.remove(chain(), "event", id, cur.version);
        known.delete(id);
        return true;
      },
      /** The caller's removed events, newest removal first (the records' Bin, include_deleted), read under the CALLER's chain so the gateway's rules decide what they may see. @param {any} as @returns {Promise<any[]>} */
      async binned(as) {
        if (!as) return [];
        const rows = await pages("event", { include_deleted: true }, as);
        return rows.filter(r => r.deleted_at).sort((a, b) => b.deleted_at - a.deleted_at).map(r => ({ id: r.id, title: r.data.title ?? "", starts_at: r.data.starts_at ?? null, removed_at: iso(r.deleted_at) }));
      },
      /** Bring an event back from the bin. @returns {Promise<any | null>} its calendar row, or null when it is not in the bin */
      async restore(/** @type {string} */ id) {
        let rec;
        try { rec = await K.records.restore(chain(), "event", id); } catch (e) { if (e && ["not_found", "bad_input"].includes(/** @type {any} */ (e).code)) return null; throw e; }
        known.set(id, rec.version);
        return fromEvent(rec, now());
      },
    },
    /** Make an item (a record or a Task) and learn its id: the one write the caller waits for. @param {any} row @param {{ chain?: any }} [w] */
    async create(row0, w = {}) {
      const row = norm(row0);
      if (row.kind === "todo") {
        // A to-do for the person is the planner's own request (the service made it); one given to an assistant is the person's, so the assistant is its doer under them.
        const given = row.assignee ? { kind: "agent", id: String(row.assignee), space } : null;
        if (given && !w.chain) throw Object.assign(new Error("only the person gives a to-do to an assistant"), { code: "denied" });
        const t = await K.tasks.request(given ? w.chain : chain(), toTaskSpec(row, given || { kind: "person", id: owner(), space }));
        const made = { ...row, id: t.id, _task: true };
        items.set(t.id, made);
        return made;
      }
      const type = typeOf(row);
      // A field with nothing in it is left out: a store may keep an empty field as no field (Twenty does), and a create that said null would then read back as something else.
      const rec = await K.records.create(chain(), type, Object.fromEntries(Object.entries(toData(row)).filter(([, v]) => v !== null && v !== undefined)), w.chain ? { on_behalf: w.chain } : {});
      versions.set(rec.id, rec.version); known.set(rec.id, rec.version);
      const made = { ...row, id: rec.id };
      items.set(rec.id, made);
      void w;
      return made;
    },
    /** Change some fields of an item; a to-do's state moves its Task under the caller's chain (`w.chain`, the person's own). @param {string} id @param {any} fields @param {{ chain?: any }} [w] */
    patch(id, fields, w = {}) {
      const r = items.get(String(id));
      if (!r) return;
      const was = r.state;
      const before = { deleted_at: r.deleted_at };
      fields = norm(fields);
      Object.assign(r, fields);
      if (r._task) {
        const keys = Object.keys(fields);
        const c = w.chain;
        const undo = { state: was, done_at: r.done_at ?? null, deleted_at: before.deleted_at ?? null };
        const edit = taskEdit(r, keys);
        const stateChange = fields.state && fields.state !== was ? fields.state : null;
        // In order: the words and form first, then the state, each under the chain that may do it. A refusal puts the working set back.
        if (Object.keys(edit).length || stateChange) {
          void enqueue(async () => {
            try {
              const mine = r.assignee ? c : chain();
              if (Object.keys(edit).length) await K.tasks.edit(mine || chain(), r.id, edit);
              if (stateChange === "done") { await K.tasks.start(c, r.id).catch(() => {}); await K.tasks.complete(c, r.id, { note: "Done in the planner", sources: [`vyre://${space}/task/${r.id}`] }); }
              else if (stateChange === "cancelled") { if (!c) throw Object.assign(new Error("a to-do is cancelled by the person"), { code: "denied" }); await K.tasks.skip(c, r.id, "cancelled in the planner"); }
              else if (stateChange === "open") { await K.tasks.reopen(c || chain(), r.id); }
            } catch (e) { Object.assign(r, undo); throw e; }
          });
        }
        return;
      }
      const type = typeOf(r);
      // Only the fields that changed: an edit made in the app meanwhile to any other field stays.
      const full = toData(r), named = Object.keys(fields).map(k => (k === "source_name" ? "added_by" : k === "deleted_at" ? "removed_at" : k));
      const patch = Object.fromEntries(Object.entries(full).filter(([k]) => named.includes(k)));
      if (!Object.keys(patch).length) return;
      busy(r.id, 1);
      void enqueue(async () => {
        try {
          const ref = { version: versions.get(r.id) ?? null };
          const rec = await updateRecord(type, r.id, patch, ref);
          if (rec) versions.set(r.id, rec.version);
        } finally { busy(r.id, -1); }
      }, `${type} ${Object.keys(patch).join(",")}`);
    },
    /** @returns {any[]} */
    list({ kind, state: st = "open", list, project, pinned, tag, limit = 100, deleted = false } = /** @type {any} */ ({})) {
      const out = [...items.values()].filter(r => (deleted ? r.deleted_at != null : r.deleted_at == null)
        && (!kind || r.kind === kind) && (!st || st === "all" || r.state === st) && (!list || r.list === list) && (!project || r.project === project)
        && (pinned === undefined || Boolean(r.pinned) === Boolean(pinned)) && (!tag || json(r.tags, []).includes(tag)));
      const when = (/** @type {any} */ r) => r.next_fire ?? r.at;
      return out.sort((a, b) => (b.pinned - a.pinned) || (Number(when(a) == null) - Number(when(b) == null)) || ((when(a) ?? 0) - (when(b) ?? 0)) || (b.priority - a.priority) || (b.created - a.created)).slice(0, limit);
    },
    all: () => [...items.values()],
    /** The chained tasks waiting on an item. */
    waitingOn: (/** @type {string} */ id) => [...items.values()].filter(r => r.kind === "task" && r.waits_on === id && r.state === "open" && r.deleted_at == null),
    /** What is due: a time that has come or a snooze that ran out. */
    dueItems: (/** @type {number} */ t) => [...items.values()].filter(r => r.state === "open" && r.deleted_at == null && ((r.next_fire != null && r.next_fire <= t) || (r.snooze_until != null && r.snooze_until <= t)))
      .sort((a, b) => (a.snooze_until ?? a.next_fire) - (b.snooze_until ?? b.next_fire)),
    /** The earliest moment anything in the working set waits for, or null. */
    nextMoment() {
      let at = null;
      const see = (/** @type {any} */ x) => { if (x != null && (at == null || x < at)) at = x; };
      for (const r of items.values()) if (r.state === "open" && r.deleted_at == null) { see(r.next_fire); see(r.snooze_until); }
      for (const f of firings.values()) if (f.state === "ringing") see(f.next_ring);
      return at;
    },
    dueRings: (/** @type {number} */ t) => [...firings.values()].filter(f => f.state === "ringing" && f.next_ring != null && f.next_ring <= t),
    /** @returns {any} */ firing: (/** @type {string} */ id) => firings.get(String(id)),
    /** The newest firing of an item for one due moment, whatever its state. @returns {any} */
    firingAt: (/** @type {string} */ item, /** @type {number} */ due) => [...firings.values()].filter(f => f.item === String(item) && f.due === Number(due)).sort((a, b) => b.fired_at - a.fired_at)[0],
    insertFiring(/** @type {any} */ f) {
      const row = { ring: 1, missed: 0, next_ring: null, acked_at: null, action: null, by: null, until: null, ...f, missed: f.missed ? 1 : 0 };
      firings.set(row.id, row);
      const ref = { rid: /** @type {string | null} */ (null), version: /** @type {number | null} */ (null) };
      refs.set(row.id, ref);
      void enqueue(async () => {
        const rec = await K.records.create(chain(), "planner_firing", Object.fromEntries(Object.entries({ fid: row.id, item: row.item, kind: row.kind, due: row.due, ring: row.ring, missed: Boolean(row.missed), state: row.state, fired_at: row.fired_at,
          next_ring: row.next_ring, acked_at: row.acked_at, action: row.action, by: row.by, until: row.until }).filter(([, v]) => v !== null && v !== undefined)));
        ref.rid = rec.id; ref.version = rec.version;
      });
    },
    patchFiring(/** @type {string} */ id, /** @type {any} */ fields) {
      const f = firings.get(String(id));
      if (!f) return;
      Object.assign(f, fields);
      const ref = refs.get(f.id);
      void enqueue(async () => {
        if (!ref || !ref.rid) return;
        const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "missed" ? Boolean(v) : v ?? null]));
        const rec = await K.records.update(chain(), "planner_firing", ref.rid, data, ref.version).catch(async e => {
          if (!e || e.code !== "version_conflict") throw e;
          const cur = await K.records.get(chain(), "planner_firing", ref.rid); return K.records.update(chain(), "planner_firing", ref.rid, data, cur.version);
        });
        ref.version = rec.version;
      }, `planner_firing ${Object.keys(fields).join(",")}`);
    },
    /** @returns {any} */ ringing: (/** @type {string} */ item) => [...firings.values()].filter(f => f.item === String(item) && f.state === "ringing").sort((a, b) => b.fired_at - a.fired_at)[0],
    allRinging: () => [...firings.values()].filter(f => f.state === "ringing").sort((a, b) => a.fired_at - b.fired_at),
    firingsOf: (/** @type {string} */ item, limit = 10) => [...firings.values()].filter(f => f.item === String(item)).sort((a, b) => b.fired_at - a.fired_at).slice(0, limit),
    supersedeRinging(/** @type {string} */ item) { for (const f of [...firings.values()]) if (f.item === item && f.state === "ringing") this.patchFiring(f.id, { state: "superseded", next_ring: null }); },
    /** Items soft-deleted more than 30 days ago go for good, with their firings; old firings go too. */
    purge(/** @type {number} */ t) {
      const cut = t - 30 * DAY;
      for (const r of [...items.values()]) {
        if (r.deleted_at == null || r.deleted_at >= cut || r._task) continue;
        items.delete(r.id);
        void enqueue(async () => { const rec = await K.records.get(chain(), typeOf(r), r.id); if (rec) await K.records.remove(chain(), typeOf(r), r.id, rec.version); });
        for (const f of [...firings.values()]) if (f.item === r.id) this.dropFiring(f.id);
      }
      for (const f of [...firings.values()]) if (f.state !== "ringing" && f.fired_at < t - FIRING_KEEP) this.dropFiring(f.id);
    },
    dropFiring(/** @type {string} */ id) {
      const ref = refs.get(id);
      firings.delete(id); refs.delete(id);
      void enqueue(async () => { if (!ref || !ref.rid) return; const rec = await K.records.get(chain(), "planner_firing", ref.rid); if (rec) await K.records.remove(chain(), "planner_firing", ref.rid, rec.version); });
    },
    /** A record changed outside the planner (or by it: the log says both): read it back in. A change that leaves the row as it is says nothing. */
    async external(/** @type {{ type: string, id: string }} */ e) {
      const same = (/** @type {any} */ a, /** @type {any} */ b) => { const strip = (/** @type {any} */ r) => { const { updated: _u, ...d } = toData(r); return JSON.stringify(d); }; return strip(a) === strip(b); };
      if (e.type === "task") {
        const t = await K.tasks.get(chain(), e.id).catch(() => null);
        const row = t && fromTask(t);
        const old = items.get(e.id);
        if (!row || !old || old.state === row.state) return;
        Object.assign(old, { state: row.state, done_at: row.done_at, updated: row.updated });
        o.onExternal?.(old, "changed");
        return;
      }
      if (e.type !== "reminder" && e.type !== "note") return;
      // Our own writes are still on their way: whatever the record shows now is older than the working set.
      if ((writing.get(e.id) || 0) > 0) return;
      const rec = await K.records.get(chain(), e.type, e.id).catch(() => null);
      if (!rec) { const old = items.get(e.id); if (old) { items.delete(e.id); o.onExternal?.(old, "removed"); } return; }
      if (known.get(e.id) === rec.version) return;
      known.set(e.id, rec.version); versions.set(e.id, rec.version);
      const row = fromRecord(rec, e.type);
      const old = items.get(e.id);
      items.set(e.id, row);
      if (old && same(old, row)) return;
      o.onExternal?.(row, old ? "changed" : "added");
    },
    newId,
  };
}
