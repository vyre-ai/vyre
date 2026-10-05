// @ts-check
// An upgrade from a real 0.2.x planner. The database is made the way the 0.2.3 planner made it: its own migrations and its own store (core/planner/legacy-fixture/store-0.2.3-rc.2.js is
// `git show v0.2.3-rc.2:core/planner/store.js`, byte for byte), written to a file on disk, then reopened by the planner that has Records. The upgrade is run again after it, over
// a second copy of the same old rows, and with a crash before every write; each time, every row the import carries is in the records exactly once, and nothing carried is lost.
//
// Not carried, by design (legacy.js): to-dos that are done or dropped, items deleted in the old planner, the cache of connected calendars (read again from Google), a setting that is not JSON.

import "../../scripts/mac-test-guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { world, MIN, HOUR, DAY, T0 } from "./testing.js";
import { migrate } from "../store/index.js";
import { MIGRATIONS as LEGACY, importLegacy } from "./legacy.js";
import { MIGRATIONS, store as oldStore } from "./legacy-fixture/store-0.2.3-rc.2.js";

const NEEDS = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs;

/** A 0.2.3 planner's database on disk, with what a used planner holds. */
function makeOld(/** @type {string} */ file) {
  const db = new DatabaseSync(file);
  // the way the 0.2.3 daemon applied them: through the store's migrate, which records each step in _migrations
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  migrate(db, "planner", MIGRATIONS);
  const st = oldStore(db);
  const base = { created: T0 - 3 * DAY, updated: T0 - 3 * DAY, source: "cli" };
  st.insert({ id: "i_alarm", kind: "alarm", title: "Wake up", at: T0 + 20 * HOUR, tz: "Asia/Karachi", wall: "07:00", repeat: { every: "day" }, next_fire: T0 + 20 * HOUR, ...base });
  st.insert({ id: "i_remind", kind: "reminder", title: "Call the printer", at: T0 + 3 * HOUR, next_fire: T0 + 3 * HOUR, tags: ["office"], list: "work", priority: 2, pinned: true, ...base });
  st.insert({ id: "i_remind2", kind: "reminder", title: "Renew the licence", at: T0 + 2 * DAY, next_fire: T0 + 2 * DAY, project: "admin", source_name: "juno", ...base });
  st.insert({ id: "i_timer", kind: "timer", title: "", duration_ms: 25 * MIN, at: T0 + 25 * MIN, next_fire: T0 + 25 * MIN, ...base });
  st.insert({ id: "i_note", kind: "note", title: "Passcodes", body: "ask Sam", tags: ["private"], ...base });
  st.insert({ id: "i_note2", kind: "note", title: "Ideas", body: "one\ntwo", list: "scratch", ...base });
  st.insert({ id: "i_todo", kind: "todo", title: "Send the invoice", date: "2026-09-30", due: "2026-09-30", priority: 1, ...base });
  st.insert({ id: "i_todo_sub", kind: "todo", title: "Attach the receipt", parent: "i_todo", ...base });
  st.insert({ id: "i_todo_orphan", kind: "todo", title: "Under a reminder", parent: "i_remind", ...base });
  st.insert({ id: "i_todo_rep", kind: "todo", title: "Water the plants", wall: "09:00", date: "2026-10-06", at: T0 + DAY, tz: "Asia/Karachi", repeat: { every: "week", days: ["tue"] }, ...base });
  st.insert({ id: "i_done", kind: "todo", title: "Already done", state: "done", done_at: T0 - HOUR, ...base });
  st.insert({ id: "i_dropped", kind: "todo", title: "Dropped", state: "cancelled", ...base });
  st.insert({ id: "i_gone", kind: "reminder", title: "Deleted", at: T0 + HOUR, deleted_at: T0 - HOUR, ...base });
  st.insert({ id: "i_event", kind: "event", title: "Retro", at: T0 + 6 * HOUR, duration_ms: 45 * MIN, tz: "Asia/Karachi", where_: "Room 2", ...base });
  st.insert({ id: "i_task", kind: "task", title: "Draft the recap", body: "write it", waits_on: "i_remind", run_count: 2, last_result: "ok", ...base });
  st.insert({ id: "i_task_paused", kind: "task", title: "Send the digest", at: T0 + DAY, paused: true, repeat: { every: "day" }, ...base });
  st.insertFiring({ id: "f_a", item: "i_remind", kind: "reminder", due: T0 - 2 * DAY, ring: 1, missed: false, state: "acked", fired_at: T0 - 2 * DAY });
  st.patchFiring("f_a", { acked_at: T0 - 2 * DAY + MIN, action: "done", by: "cli" });
  st.insertFiring({ id: "f_b", item: "i_event", kind: "event", due: T0 - DAY, ring: 1, missed: true, state: "missed", fired_at: T0 - DAY });
  st.insertFiring({ id: "f_ring", item: "i_alarm", kind: "alarm", due: T0 - HOUR, ring: 2, missed: false, state: "ringing", fired_at: T0 - HOUR, next_ring: T0 + MIN });
  st.insertFiring({ id: "f_orphan", item: "i_gone", kind: "reminder", due: T0 - DAY, ring: 1, missed: false, state: "acked", fired_at: T0 - DAY });
  st.state.set("settings", { timezone: "Asia/Karachi", escalate_after: 7 });
  st.state.set("last_purge", T0 - DAY);
  db.prepare("INSERT INTO planner_state (key, value) VALUES (?, ?)").run("broken", "{not json");
  db.prepare("INSERT INTO planner_calendar (id, account, event_id, title, start, synced_at) VALUES ('c1', 'alex', 'e1', 'Google copy', ?, ?)").run(T0 + HOUR, T0);
  return db;
}

/** What the import must carry, read from the old database itself (not from a list kept here). */
function expectedFrom(/** @type {DatabaseSync} */ db) {
  const all = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_items").all());
  const skipped = all.filter(r => r.deleted_at != null || (r.kind === "todo" && r.state !== "open"));
  const carried = all.filter(r => !skipped.includes(r));
  const ids = new Set(carried.map(r => r.id));
  const firings = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_firings").all()).filter(f => ids.has(f.item));
  const settings = /** @type {any[]} */ (db.prepare("SELECT * FROM planner_state").all()).filter(s => { try { JSON.parse(String(s.value)); return true; } catch { return false; } });
  return { carried, skipped, firings, settings };
}

const idOf = (/** @type {any} */ rec, /** @type {string} */ type) => type === "event" ? /^planner:(.+)$/.exec(String(rec.data.external_id || ""))?.[1] : rec.data.legacy_id;

/** Every record the import made, by the old id (or ring id, or key), with how many there are of each. */
async function inventory(/** @type {any} */ w, /** @type {any} */ K) {
  const R = w.k.gateway.records;
  const page = async (/** @type {string} */ type) => (await R.query(w.owner, type, { page: { limit: 500 } })).rows;
  /** @type {Map<string, number>} */ const made = new Map();
  const bump = (/** @type {string} */ k) => made.set(k, (made.get(k) || 0) + 1);
  for (const type of ["reminder", "note"]) for (const r of await page(type)) { const id = idOf(r, type); if (id) bump(`item:${id}`); }
  for (const r of await page("event")) { if (r.data.source !== "vyre") continue; const id = idOf(r, "event"); if (id) bump(`item:${id}`); }
  for (const t of await page("task")) { let p = null; try { p = JSON.parse(t.data.planner || "null"); } catch { p = null; } if (p && p.legacy_id) bump(`item:${p.legacy_id}`); }
  for (const r of await page("planner_firing")) bump(`ring:${r.data.fid}`);
  for (const r of await page("planner_state")) bump(`key:${r.data.key}`);
  return made;
}
function assertExactlyOnce(/** @type {Map<string, number>} */ made, /** @type {ReturnType<typeof expectedFrom>} */ want, /** @type {string} */ when) {
  const keys = [...want.carried.map(r => `item:${r.id}`), ...want.firings.map(f => `ring:${f.id}`), ...want.settings.map(s => `key:${s.key}`)];
  for (const k of keys) assert.equal(made.get(k), 1, `${when}: ${k} is in the records exactly once (lost if 0, duplicated if more)`);
  assert.deepEqual([...made.keys()].filter(k => !keys.includes(k)), [], `${when}: nothing else was made (skipped rows stay behind)`);
}
const tables = (/** @type {DatabaseSync} */ db) => /** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planner_%'").all()).map(r => r.name);
/** The store a planner with Records is started over: the daemon's, whose migrate puts the module's whole list (the five released steps and the one this release adds) on the database. */
const storeFor = (/** @type {DatabaseSync} */ db) => ({ db, migrate: (/** @type {string[]} */ steps) => migrate(db, "planner", steps) });
const upgrade = (/** @type {DatabaseSync} */ db) => migrate(db, "planner", LEGACY);
const moved = (/** @type {DatabaseSync} */ db) => /** @type {any[]} */ (db.prepare("SELECT id FROM planner_moved").all()).map(r => r.id);
const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "planner-legacy-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test("upgrade from a real 0.2.3 planner database: carried once, nothing lost, skipped rows named", async t => {
  const dir = tmp(t);
  const file = path.join(dir, "planner.db");
  const db = makeOld(file);
  const want = expectedFrom(db);
  assert.deepEqual(want.skipped.map(r => r.id).sort(), ["i_done", "i_dropped", "i_gone"], "skipped: done and dropped to-dos, and what was deleted");
  assert.equal(want.carried.length, 13);
  assert.equal(want.settings.length, 2, "the setting that is not JSON is skipped");
  db.close();

  // first start with Records: the file is opened by the planner, which carries and drops
  const first = new DatabaseSync(file);
  const w = await world(t, { store: storeFor(first) });
  const K = w.k.kernelFor({ name: "planner", needs: NEEDS });
  assertExactlyOnce(await inventory(w, K), want, "after the first start");
  assert.equal(tables(first).length, 5, "the old tables stay (a table goes only through an appended migration step), beside planner_moved");
  assert.ok(moved(first).includes("~complete"), "the run that carried everything says so");
  assert.deepEqual(moved(first).filter(id => id !== "~complete").sort(), want.carried.map(r => r.id).sort(), "and lists what it carried");
  first.close();

  // a second start over the same records, the database reopened from disk: nothing to carry, nothing added
  const reopened = new DatabaseSync(file);
  assert.equal(await importLegacy({ db: reopened, K, log: () => {} }), null);
  const w2 = await world(t, { kernel: w.k, store: storeFor(reopened) });
  assertExactlyOnce(await inventory(w2, K), want, "after the second start");

  // what a person sees after the upgrade
  const items = await w2.ok("planner.list", { state: "all", limit: 200 });
  const byTitle = Object.fromEntries(items.map((/** @type {any} */ x) => [x.title, x]));
  for (const title of ["Wake up", "Call the printer", "Renew the licence", "Timer", "Passcodes", "Ideas", "Send the invoice", "Attach the receipt", "Under a reminder", "Water the plants", "Draft the recap", "Send the digest"]) assert.ok(byTitle[title], `${title} came across`);
  for (const gone of ["Already done", "Dropped", "Deleted", "Google copy"]) assert.equal(byTitle[gone], undefined, `${gone} is not carried`);
  assert.deepEqual(byTitle["Wake up"].repeat, { every: "day" });
  assert.deepEqual([byTitle["Call the printer"].tags, byTitle["Call the printer"].list, byTitle["Call the printer"].priority, byTitle["Call the printer"].pinned], [["office"], "work", 2, true]);
  assert.equal(byTitle["Renew the licence"].added_by, "juno");
  assert.equal(byTitle["Timer"].duration_ms, 25 * MIN);
  assert.equal(byTitle["Draft the recap"].waits_on, byTitle["Call the printer"].id, "a chained task follows the new record");
  assert.equal(byTitle["Draft the recap"].run_count, 2);
  assert.equal(byTitle["Send the digest"].paused, true);
  assert.equal(byTitle["Attach the receipt"].parent, byTitle["Send the invoice"].id, "a to-do under a to-do keeps its place");
  assert.equal(byTitle["Under a reminder"].parent, null, "a to-do that sat under a reminder is carried without a parent: a Task's parent is another to-do");
  assert.deepEqual(byTitle["Water the plants"].repeat, { every: "week", days: ["tue"] }, "a repeating to-do keeps its repeat");
  assert.equal((await w2.ok("planner.settings")).escalate_after, 7);
  const ev = (await w2.ok("planner.agenda", { from: new Date(T0).toISOString(), to: new Date(T0 + DAY).toISOString() })).entries.find((/** @type {any} */ x) => x.title === "Retro");
  assert.deepEqual([ev.where, ev.end - ev.start], ["Room 2", 45 * MIN]);
  reopened.close();
});

test("upgrade: the same old rows carried again over the records already made add nothing", async t => {
  const dir = tmp(t);
  const a = makeOld(path.join(dir, "a.db"));
  const want = expectedFrom(a);
  const w = await world(t, { store: storeFor(a) });
  const K = w.k.kernelFor({ name: "planner", needs: NEEDS });
  assertExactlyOnce(await inventory(w, K), want, "first");
  // a restored backup of the same old database, the import run over it again
  const b = makeOld(path.join(dir, "b.db"));
  upgrade(b);
  assert.ok(await importLegacy({ db: b, K, log: () => {} }));
  assert.equal(tables(b).length, 5);
  assertExactlyOnce(await inventory(w, K), want, "after the second import");
});

test("upgrade: a crash before any write leaves the old tables, and the re-run finishes with exactly one of each", async t => {
  const dir = tmp(t);
  const probe = makeOld(path.join(dir, "probe.db"));
  const want = expectedFrom(probe);
  const total = want.carried.length + want.firings.length + want.settings.length;
  probe.close();
  for (let limit = 0; limit < total; limit++) {
    const db = makeOld(path.join(dir, `crash-${limit}.db`));
    upgrade(db);
    const w = await world(t);
    const real = w.k.kernelFor({ name: "planner", needs: NEEDS });
    let writes = 0;
    const crashing = /** @type {any} */ ({ ...real,
      records: { ...real.records, create: async (/** @type {any[]} */ ...a) => { if (writes++ >= limit) throw new Error("crash"); return real.records.create(...a); } },
      tasks: { ...real.tasks, request: async (/** @type {any[]} */ ...a) => { if (writes++ >= limit) throw new Error("crash"); return real.tasks.request(...a); } } });
    assert.equal(await importLegacy({ db, K: crashing, log: () => {} }), null, `limit ${limit}: a crash reports nothing carried`);
    assert.equal(tables(db).length, 5, `limit ${limit}: the old tables stay`);
    assert.ok(!moved(db).includes("~complete"), `limit ${limit}: a crashed run is not marked complete`);
    assert.ok(await importLegacy({ db, K: real, log: () => {} }), `limit ${limit}: the re-run finishes`);
    assertExactlyOnce(await inventory(w, real), want, `limit ${limit}`);
    assert.equal(tables(db).length, 5, `limit ${limit}: the tables are still there`);
    assert.ok(moved(db).includes("~complete"), `limit ${limit}: and the finished run is marked`);
    db.close();
  }
});

test("upgrade: the fixture's five steps are the released ones, and the module's list is those five plus planner_moved", () => {
  assert.deepEqual(LEGACY.slice(0, 5), MIGRATIONS, "the released steps in legacy.js are the 0.2.3 store's, unedited");
  assert.equal(LEGACY.length, 6);
  assert.match(LEGACY[5], /CREATE TABLE planner_moved/);
});

test("upgrade: a start after a complete run does nothing, whatever the old tables hold", async t => {
  const dir = tmp(t);
  const db = makeOld(path.join(dir, "done.db"));
  const w = await world(t, { store: storeFor(db) });
  const real = w.k.kernelFor({ name: "planner", needs: NEEDS });
  let writes = 0;
  const spy = /** @type {any} */ ({ ...real, records: { ...real.records, create: async (/** @type {any[]} */ ...a) => { writes++; return real.records.create(...a); } }, tasks: { ...real.tasks, request: async (/** @type {any[]} */ ...a) => { writes++; return real.tasks.request(...a); } } });
  db.prepare("INSERT INTO planner_items (id, kind, title, created, updated) VALUES ('i_late', 'note', 'Added after the move', 1, 1)").run();
  assert.equal(await importLegacy({ db, K: spy, log: () => {} }), null);
  assert.equal(writes, 0, "nothing is read from the old tables again once the list says everything moved");
});
