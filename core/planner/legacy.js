// @ts-check
// A planner that kept its own tables (0.2.x: planner_items, planner_firings, planner_calendar and planner_state) brings what they hold into the
// Space's records once, at the first start that has the kernel, and then drops the tables. Nothing is read from them again.
//   alarms, timers, reminders and tasks that run later  -> `reminder` records      notes -> `note` records
//   events the planner made                              -> `event` records         open todos -> the kernel's Tasks (a done or dropped todo is not carried)
//   rings and their answers, and the settings            -> `planner-ring` and `planner-state` records
// The connected calendars' copy is not carried: it is read again from Google within 15 minutes of the first start.

import { store } from "./store.js";

const TABLES = ["planner_items", "planner_firings", "planner_calendar", "planner_state"];

/**
 * @param {{ db: import("node:sqlite").DatabaseSync | undefined, K: any, log: (m: string) => void }} o
 * @returns {Promise<{ items: number, firings: number, settings: number } | null>} what was carried, or null when there was nothing to carry
 */
export async function importLegacy({ db, K, log }) {
  if (!db) return null;
  const has = (/** @type {string} */ t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  if (!has("planner_items")) return null;
  const rows = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_items WHERE deleted_at IS NULL ORDER BY created").all());
  const firings = has("planner_firings") ? /** @type {any[]} */ (db.prepare("SELECT * FROM planner_firings").all()) : [];
  const state = has("planner_state") ? /** @type {any[]} */ (db.prepare("SELECT * FROM planner_state").all()) : [];
  const tmp = store({ K, log });
  /** @type {Map<string, string>} the old id to the record's */ const ids = new Map();
  let items = 0;
  for (const r of rows) {
    if (r.kind === "todo" && r.state !== "open") continue;
    const { id: old, parent: _parent, waits_on: _waits, ...rest } = r;
    // The old rows hold tags and the repeat rule as JSON text; the store takes them as values.
    const json = (/** @type {any} */ v, /** @type {any} */ none) => { try { return v == null ? none : JSON.parse(String(v)); } catch { return none; } };
    try { ids.set(old, await tmp.insert({ ...rest, tags: json(rest.tags, []), repeat: json(rest.repeat, null), parent: null, waits_on: null })); items++; }
    catch (e) { log(`planner: item ${old} was not carried (${/** @type {Error} */ (e).message})`); }
  }
  for (const r of rows) {
    const id = ids.get(r.id);
    if (!id || r.kind === "todo") continue;
    const patch = /** @type {any} */ ({});
    if (r.parent && ids.has(r.parent)) patch.parent = ids.get(r.parent);
    if (r.waits_on && ids.has(r.waits_on)) patch.waits_on = ids.get(r.waits_on);
    if (Object.keys(patch).length) tmp.patch(id, patch);
  }
  let rings = 0;
  for (const f of firings) {
    const item = ids.get(f.item);
    if (!item) continue;
    tmp.insertFiring({ id: f.id, item, kind: f.kind, due: f.due, ring: f.ring, missed: f.missed, state: f.state, fired_at: f.fired_at, next_ring: f.next_ring });
    const more = /** @type {any} */ ({});
    for (const k of ["acked_at", "action", "by", "until"]) if (f[k] != null) more[k] = f[k];
    if (Object.keys(more).length) tmp.patchFiring(f.id, more);
    rings++;
  }
  let settings = 0;
  for (const s of state) { try { tmp.state.set(s.key, JSON.parse(s.value)); settings++; } catch { /* an unreadable setting is as if it were not set */ } }
  await tmp.flush();
  if (tmp.failures() > 0) { log(`planner: ${tmp.failures()} records were not written; the old tables are kept and read again at the next start`); return null; }
  for (const t of TABLES) if (has(t)) db.exec(`DROP TABLE ${t}`);
  log(`planner: carried ${items} items, ${rings} rings and ${settings} settings into the Space's records; the planner's own tables are gone`);
  return { items, firings: rings, settings };
}
