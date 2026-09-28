// @ts-check
// The planner's tables (ADR 0025 point 2): one item shape for alarms, timers, reminders, todos,
// notes and events; one row per firing; a cache of connected calendars; and small settings.

import crypto from "node:crypto";

export const MIGRATIONS = [
  `CREATE TABLE planner_items (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT,
     list TEXT, priority INTEGER NOT NULL DEFAULT 0, parent TEXT, project TEXT, thread TEXT,
     tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL DEFAULT 'open',
     at INTEGER, tz TEXT, floating INTEGER NOT NULL DEFAULT 0, wall TEXT, date TEXT, repeat TEXT, due TEXT,
     duration_ms INTEGER, snooze_until INTEGER, next_fire INTEGER,
     created INTEGER NOT NULL, updated INTEGER NOT NULL, done_at INTEGER, deleted_at INTEGER, source TEXT);
   CREATE INDEX planner_items_fire ON planner_items (next_fire) WHERE next_fire IS NOT NULL;
   CREATE INDEX planner_items_snooze ON planner_items (snooze_until) WHERE snooze_until IS NOT NULL;
   CREATE INDEX planner_items_kind ON planner_items (kind, state);
   CREATE TABLE planner_firings (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, due INTEGER NOT NULL,
     ring INTEGER NOT NULL DEFAULT 1, missed INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL, fired_at INTEGER NOT NULL, next_ring INTEGER,
     acked_at INTEGER, action TEXT, by TEXT, until INTEGER);
   CREATE INDEX planner_firings_item ON planner_firings (item, fired_at);
   CREATE INDEX planner_firings_ring ON planner_firings (next_ring) WHERE next_ring IS NOT NULL;
   CREATE TABLE planner_calendar (
     id TEXT PRIMARY KEY, account TEXT NOT NULL, event_id TEXT NOT NULL, title TEXT, start INTEGER NOT NULL, end INTEGER,
     all_day INTEGER NOT NULL DEFAULT 0, where_ TEXT, url TEXT, synced_at INTEGER NOT NULL,
     UNIQUE (account, event_id));
   CREATE INDEX planner_calendar_start ON planner_calendar (start);
   CREATE TABLE planner_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // The calendar slice: a cached event's pending ring, the start it last rang for (so a resync
  // never rings twice), a snooze; and a place for the planner's own events.
  `ALTER TABLE planner_calendar ADD COLUMN next_fire INTEGER;
   ALTER TABLE planner_calendar ADD COLUMN rung_start INTEGER;
   ALTER TABLE planner_calendar ADD COLUMN snooze_until INTEGER;
   CREATE INDEX planner_calendar_fire ON planner_calendar (next_fire) WHERE next_fire IS NOT NULL;
   ALTER TABLE planner_items ADD COLUMN where_ TEXT;`,
  // Who added an item, as the person sees it: an agent's name, or null for the person and their assistant.
  `ALTER TABLE planner_items ADD COLUMN source_name TEXT;`,
  // /later (the user's decision, 2026-09-28): a "task" item runs an instruction instead of
  // ringing one. waits_on chains it after another item's own done (rule: "when X finishes, do
  // Y"), resolved by a listener on planner.changed, not by the scheduler's time-based nextFire.
  // run_count and last_result make a recurring task's history visible (rule 2: a runaway loop
  // must be visible), and paused lets a person stop just this one without deleting it.
  `ALTER TABLE planner_items ADD COLUMN waits_on TEXT;
   ALTER TABLE planner_items ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE planner_items ADD COLUMN last_result TEXT;
   ALTER TABLE planner_items ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;`,
];

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

/** Short random ids: i_ for items, f_ for firings. */
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
  };
}
export const shapeFiring = f => f && ({ id: f.id, item: f.item, kind: f.kind, key: ringKey(f.item, f.due), due: f.due, ring: f.ring, missed: Boolean(f.missed), state: f.state,
  fired_at: f.fired_at, next_ring: f.next_ring ?? null, acked_at: f.acked_at ?? null, action: f.action ?? null, by: f.by ?? null, until: f.until ?? null });

function safeJSON(s, fallback) { try { return s == null ? fallback : JSON.parse(String(s)); } catch { return fallback; } }

const COLUMNS = ["kind", "title", "body", "list", "priority", "parent", "project", "thread", "tags", "pinned", "state", "at", "tz", "floating",
  "wall", "date", "repeat", "due", "duration_ms", "snooze_until", "next_fire", "created", "updated", "done_at", "deleted_at", "source", "source_name", "where_",
  "waits_on", "run_count", "last_result", "paused"];

/** Plain values for SQLite: objects as JSON, booleans as 0/1. */
const cell = (k, v) => v === undefined ? null : (k === "tags" || k === "repeat") ? (v == null ? (k === "tags" ? "[]" : null) : JSON.stringify(v))
  : typeof v === "boolean" ? (v ? 1 : 0) : v;

/** The planner's store over one DatabaseSync. */
export function store(db) {
  const state = {
    get: (k, fallback = undefined) => { const r = /** @type {any} */ (db.prepare("SELECT value FROM planner_state WHERE key = ?").get(k)); return r ? JSON.parse(String(r.value)) : fallback; },
    set: (k, v) => db.prepare("INSERT INTO planner_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v)),
  };
  return {
    state,
    /** @returns {any} */
    item: id => db.prepare("SELECT * FROM planner_items WHERE id = ?").get(String(id)),
    /** @returns {any} */
    firing: id => db.prepare("SELECT * FROM planner_firings WHERE id = ?").get(String(id)),
    /** The newest firing of an item for one due moment, whatever its state. @returns {any} */
    firingAt: (item, due) => db.prepare("SELECT * FROM planner_firings WHERE item = ? AND due = ? ORDER BY fired_at DESC LIMIT 1").get(String(item), Number(due)),
    insert(row) {
      const cols = ["id", ...COLUMNS.filter(k => row[k] !== undefined)];
      db.prepare(`INSERT INTO planner_items (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map(k => cell(k, row[k])));
    },
    /** Change some columns of an item. */
    patch(id, fields) {
      const keys = Object.keys(fields).filter(k => COLUMNS.includes(k));
      if (!keys.length) return;
      db.prepare(`UPDATE planner_items SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map(k => cell(k, fields[k])), String(id));
    },
    /** @returns {any[]} */
    list({ kind, state: st = "open", list, project, pinned, tag, limit = 100, deleted = false } = {}) {
      const where = [deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"], args = [];
      if (kind) { where.push("kind = ?"); args.push(kind); }
      if (st && st !== "all") { where.push("state = ?"); args.push(st); }
      if (list) { where.push("list = ?"); args.push(list); }
      if (project) { where.push("project = ?"); args.push(project); }
      if (pinned !== undefined) { where.push("pinned = ?"); args.push(pinned ? 1 : 0); }
      if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(planner_items.tags) WHERE value = ?)"); args.push(tag); }
      return db.prepare(`SELECT * FROM planner_items WHERE ${where.join(" AND ")}
        ORDER BY pinned DESC, COALESCE(next_fire, at) IS NULL, COALESCE(next_fire, at), priority DESC, created DESC LIMIT ?`).all(...args, limit);
    },
    insertFiring(f) {
      db.prepare(`INSERT INTO planner_firings (id, item, kind, due, ring, missed, state, fired_at, next_ring) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(f.id, f.item, f.kind, f.due, f.ring, f.missed ? 1 : 0, f.state, f.fired_at, f.next_ring ?? null);
    },
    patchFiring(id, fields) {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE planner_firings SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map(k => fields[k] ?? null), String(id));
    },
    /** The item's firing still ringing, if any. @returns {any} */
    ringing: item => db.prepare("SELECT * FROM planner_firings WHERE item = ? AND state = 'ringing' ORDER BY fired_at DESC LIMIT 1").get(String(item)),
    /** Every firing still ringing, oldest first. @returns {any[]} */
    allRinging: () => db.prepare("SELECT * FROM planner_firings WHERE state = 'ringing' ORDER BY fired_at").all(),
    /** @returns {any[]} */
    firingsOf: (item, limit = 10) => db.prepare("SELECT * FROM planner_firings WHERE item = ? ORDER BY fired_at DESC LIMIT ?").all(String(item), limit),
    /** Items soft-deleted more than 30 days ago go for good, with their firings. */
    purge(now) {
      const cut = now - 30 * 86_400_000;
      db.prepare("DELETE FROM planner_firings WHERE item IN (SELECT id FROM planner_items WHERE deleted_at IS NOT NULL AND deleted_at < ?)").run(cut);
      db.prepare("DELETE FROM planner_items WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cut);
    },
  };
}
