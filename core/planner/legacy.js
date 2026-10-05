// @ts-check
// The planner's old tables, kept only so an upgraded box moves its items into Records (the Space's own store) once. The first five steps are released and never change (test/migrations.released.json:
// a module's list is append-only); the sixth records which old rows have moved. Nothing reads or writes these tables except `importLegacy`.

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

const safeJSON = (/** @type {any} */ s, /** @type {any} */ fallback) => { try { return s == null ? fallback : JSON.parse(String(s)); } catch { return fallback; } };

/** An old row as the planner's items are shaped now: JSON parsed, flags as booleans, nothing of the old scheduler's bookkeeping. @param {any} r */
export function shapeLegacy(r) {
  return {
    kind: r.kind, title: r.title, body: r.body ?? null, list: r.list ?? null, priority: r.priority ?? 0, parent: null,
    project: r.project ?? null, thread: r.thread ?? null, tags: safeJSON(r.tags, []), pinned: Boolean(r.pinned), state: r.state,
    at: r.at ?? null, tz: r.tz ?? null, floating: Boolean(r.floating), wall: r.wall ?? null, date: r.date ?? null,
    repeat: safeJSON(r.repeat, null), due: r.due ?? null, duration_ms: r.duration_ms ?? null, snooze_until: r.snooze_until ?? null,
    created: r.created, updated: r.updated, done_at: r.done_at ?? null, source: r.source ?? null, added_by: r.source_name ?? null, where: r.where_ ?? null,
    waits_on: r.waits_on ?? null, paused: Boolean(r.paused),
  };
}

/**
 * Move the old items into Records, once each. `make` puts one shaped item into the planner (its working set and the Space's store) and answers it; a row that fails stays unmoved and is tried again at
 * the next start, so nothing is lost and nothing is made twice. Events cached from a calendar are not items and are not moved (the sync fills them again). Returns how many moved.
 * @param {any} db the module's database @param {(item: any) => Promise<{ id: string } | null | undefined>} make @param {() => number} now @param {(line: string) => void} [log]
 */
export async function importLegacy(db, make, now, log = () => {}) {
  let has = false;
  try { db.prepare("SELECT 1 FROM planner_moved LIMIT 1").get(); has = true; } catch { has = false; }
  if (!has) return 0;
  /** @type {any[]} */ const rows = db.prepare("SELECT * FROM planner_items WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM planner_moved) ORDER BY created").all();
  let n = 0;
  for (const r of rows) {
    try {
      const made = await make(shapeLegacy(r));
      if (!made) continue;
      db.prepare("INSERT OR IGNORE INTO planner_moved (id, as_type, at) VALUES (?, ?, ?)").run(String(r.id), String(r.kind), now());
      n++;
    } catch (e) { log(`planner: old item ${r.id} was not moved yet (${/** @type {Error} */ (e).message})`); }
  }
  if (n) log(`planner: ${n} item(s) moved from the old tables into Records`);
  return n;
}
