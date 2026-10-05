// @ts-check
// The planner's old tables (0.2.x: planner_items, planner_firings, planner_calendar, planner_state), kept so an upgraded box brings what they hold into the Space's records once, at the
// first start that has the kernel. The first five migration steps are released and never change (test/migrations.released.json: a module's list is append-only); the sixth,
// `planner_moved`, is this file's bookkeeping. The tables themselves are never dropped here: a table goes only through a step appended to MIGRATIONS.
//   alarms, timers, reminders and tasks that run later  -> `reminder` records      notes -> `note` records
//   events the planner made                              -> `event` records         open todos -> the kernel's Tasks (a done or dropped todo is not carried)
//   rings and their answers, and the settings            -> `planner_firing` and `planner_state` records
// The connected calendars' copy is not carried: it is read again from Google within 15 minutes of the first start. Items soft-deleted in the old planner are not carried.
//
// A crash part way leaves the tables as they are, and the next start runs the import again. It never writes anything twice: every record it makes carries the old id
// (a Reminder or Note's `legacy_id`, an event's `external_id` as "planner:<id>", a Task's `form.planner.legacy_id`), a ring keeps its own unique ring id and a setting its
// unique key, and the import first reads which of those are already in the records and carries only the rest. `planner_moved` repeats that as a list, written after the records
// are, and a run that carried everything adds one row "~complete", so every later start does nothing at all.

import { toData, toTaskSpec, typeOf } from "./records.js";

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
  // Bug fix: a chained task never re-armed itself (the comment above was already the intended
  // rule), but nothing recorded WHICH of the dependency's done_at instants it already ran for -
  // the task's own state stays "open" forever (running it does not finish it), so reopening the
  // dependency and finishing it again re-fired the same chained task a second time. waits_on_fired
  // is the dependency's done_at at the moment this task last ran for it; a later done with the
  // same done_at is a no-op, a new (later) done_at fires again.
  `ALTER TABLE planner_items ADD COLUMN waits_on_fired INTEGER;`,

  // The move to Records: which old items have been put into the Space's records, and as what, so a restart or a second start never makes one twice.
  `CREATE TABLE planner_moved (id TEXT PRIMARY KEY, as_type TEXT NOT NULL, at INTEGER NOT NULL);`,
];

const iso = (/** @type {any} */ ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

/**
 * @param {{ db: import("node:sqlite").DatabaseSync | undefined | null, K: any, log: (m: string) => void }} o
 * @returns {Promise<{ items: number, firings: number, settings: number, already: number } | null>} what was carried now, or null when there was nothing to carry or something was not
 *   written (the tables are kept and the import runs again at the next start)
 */
export async function importLegacy({ db, K, log }) {
  if (!db) return null;
  const has = (/** @type {string} */ t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  if (!has("planner_items")) return null;
  // The bookkeeping table is the sixth migration step; a database without it (a test that did not run the list) is imported all the same, just without the list.
  const book = has("planner_moved");
  if (book && db.prepare("SELECT 1 FROM planner_moved WHERE id = '~complete'").get()) return null;
  const chain = () => K.serviceChain();
  const rows = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_items WHERE deleted_at IS NULL ORDER BY created, id").all());
  const firings = has("planner_firings") ? /** @type {any[]} */ (db.prepare("SELECT * FROM planner_firings ORDER BY fired_at, id").all()) : [];
  const state = has("planner_state") ? /** @type {any[]} */ (db.prepare("SELECT * FROM planner_state").all()) : [];

  const pages = async (/** @type {string} */ type) => {
    const out = [];
    let cursor;
    for (let i = 0; i < 500; i++) {
      const r = await K.records.query(chain(), type, { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      out.push(...r.rows);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return out;
  };

  // What an earlier, interrupted run already carried, by the old id.
  /** @type {Map<string, { type: string, id: string }>} */ const carried = new Map();
  for (const type of ["reminder", "note"]) for (const rec of await pages(type)) if (rec.data && rec.data.legacy_id) carried.set(String(rec.data.legacy_id), { type, id: rec.id });
  for (const rec of await pages("event")) { const x = /^planner:(.+)$/.exec(String((rec.data && rec.data.external_id) || "")); if (x && rec.data.source === "vyre") carried.set(x[1], { type: "event", id: rec.id }); }
  const doer = { kind: "person", id: K.owner, space: K.space };
  const tasks = K.tasks && K.tasks.list ? await K.tasks.list(chain(), { doer: K.owner }).catch(() => []) : [];
  for (const t of tasks) { const p = t.form && t.form.planner; if (p && p.legacy_id) carried.set(String(p.legacy_id), { type: "task", id: t.id }); }
  const haveFid = new Set((await pages("planner_firing")).map((/** @type {any} */ r) => r.data.fid));
  const haveKey = new Set((await pages("planner_state")).map((/** @type {any} */ r) => r.data.key));

  let items = 0, firingsMade = 0, settings = 0, failed = 0;
  const already = carried.size;
  const fail = (/** @type {string} */ what, /** @type {any} */ e) => { failed++; log(`planner: ${what} was not carried (${e && e.message})`); };

  // An old to-do could sit under any item; a Task's parent is another Task. So a to-do goes in after the to-do it sat under, and keeps the nesting only when that one is carried too.
  const byId = new Map(rows.map(r => [r.id, r]));
  const depth = (/** @type {any} */ r) => { let d = 0; for (let x = r; x && x.parent && byId.has(x.parent) && d < 50; x = byId.get(x.parent)) d++; return d; };
  const order = rows.map((r, i) => ({ r, i, d: r.kind === "todo" ? depth(r) : 0 })).sort((a, b) => a.d - b.d || a.i - b.i).map(x => x.r);
  for (const row of order) {
    if (carried.has(row.id)) continue;
    if (row.kind === "todo" && row.state !== "open") continue;
    // A title is required of a record; an old row with none gets what the planner would have called it.
    const r = row.title ? row : { ...row, title: row.kind === "alarm" ? "Alarm" : row.kind === "timer" ? "Timer" : "(no title)" };
    try {
      if (r.kind === "todo") {
        const under = r.parent ? carried.get(r.parent) : null;
        const spec = toTaskSpec({ ...r, parent: under && under.type === "task" ? under.id : null }, doer);
        spec.form.planner.legacy_id = r.id;
        const t = await K.tasks.request(chain(), spec);
        carried.set(r.id, { type: "task", id: t.id });
      } else if (r.kind === "event") {
        if (r.at == null) continue;
        const end = r.at + (r.duration_ms ? Number(r.duration_ms) : 3_600_000);
        const rec = await K.records.create(chain(), "event", { title: r.title || "(no title)", starts_at: iso(r.at), ends_at: iso(end), all_day: false, ...(r.tz ? { time_zone: r.tz } : {}),
          source: "vyre", external_id: `planner:${r.id}`, ...(r.where_ ? { place: String(r.where_).slice(0, 500) } : {}) });
        carried.set(r.id, { type: "event", id: rec.id });
      } else {
        const type = typeOf(r);
        const rec = await K.records.create(chain(), type, { ...toData({ ...r, waits_on: null }), legacy_id: r.id });
        carried.set(r.id, { type, id: rec.id });
      }
      items++;
    } catch (e) { fail(`item ${r.id}`, e); }
  }

  // A chained task ran after another item's own done: point it at that item's new record. Setting the same value twice changes nothing.
  for (const r of rows) {
    const me = carried.get(r.id), dep = r.waits_on ? carried.get(r.waits_on) : null;
    if (!me || !dep || me.type !== "reminder") continue;
    try {
      const rec = await K.records.get(chain(), "reminder", me.id);
      if (rec && rec.data.waits_on !== dep.id) await K.records.update(chain(), "reminder", me.id, { waits_on: dep.id }, rec.version);
    } catch (e) { fail(`the chain of item ${r.id}`, e); }
  }

  for (const f of firings) {
    const item = carried.get(f.item);
    if (!item || haveFid.has(f.id)) continue;
    try {
      await K.records.create(chain(), "planner_firing", { fid: f.id, item: item.id, kind: f.kind, due: f.due, ring: f.ring, missed: Boolean(f.missed), state: f.state, fired_at: f.fired_at,
        next_ring: f.next_ring ?? null, acked_at: f.acked_at ?? null, action: f.action ?? null, by: f.by ?? null, until: f.until ?? null });
      firingsMade++;
    } catch (e) { fail(`ring ${f.id}`, e); }
  }

  for (const s of state) {
    if (haveKey.has(s.key)) continue;
    try { JSON.parse(String(s.value)); } catch { continue; } // an unreadable setting is as if it were not set
    try { await K.records.create(chain(), "planner_state", { key: s.key, value: String(s.value) }); settings++; } catch (e) { fail(`setting ${s.key}`, e); }
  }

  if (failed > 0) { log(`planner: ${failed} things were not written; the old tables are kept and read again at the next start`); return null; }
  if (book) {
    const mark = db.prepare("INSERT OR IGNORE INTO planner_moved (id, as_type, at) VALUES (?, ?, ?)");
    for (const [id, c] of carried) mark.run(id, c.type, Date.now());
    mark.run("~complete", "all", Date.now());
  }
  log(`planner: carried ${items} items, ${firingsMade} rings and ${settings} settings into the Space's records (${already} were already there); the old tables are left as they are`);
  return { items, firings: firingsMade, settings, already };
}
