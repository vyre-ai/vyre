// @ts-check
// The planner that kept its own tables (0.2.x) is carried into the Space's records once. A crash part way is safe: the tables stay, the next start carries only what is not yet
// there, and nothing is ever made twice.

import "../../scripts/mac-test-guard.mjs";
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { world, MIN, HOUR, DAY, T0, FACTS } from "./testing.js";
import { importLegacy } from "./legacy.js";

const NEEDS = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs;

/** The 0.2.x planner's tables (core/planner/store.js at 97133afe1), with what a planner that had been used holds. */
function oldDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE planner_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT, list TEXT, priority INTEGER NOT NULL DEFAULT 0, parent TEXT, project TEXT, thread TEXT,
    tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open', at INTEGER, tz TEXT, floating INTEGER NOT NULL DEFAULT 0, wall TEXT, date TEXT, repeat TEXT, due TEXT,
    duration_ms INTEGER, snooze_until INTEGER, next_fire INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, done_at INTEGER, deleted_at INTEGER, source TEXT, where_ TEXT, source_name TEXT,
    waits_on TEXT, run_count INTEGER NOT NULL DEFAULT 0, last_result TEXT, paused INTEGER NOT NULL DEFAULT 0, waits_on_fired INTEGER);
   CREATE TABLE planner_firings (id TEXT PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, due INTEGER NOT NULL, ring INTEGER NOT NULL DEFAULT 1, missed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
    fired_at INTEGER NOT NULL, next_ring INTEGER, acked_at INTEGER, action TEXT, by TEXT, until INTEGER);
   CREATE TABLE planner_calendar (id TEXT PRIMARY KEY, account TEXT NOT NULL, event_id TEXT NOT NULL, title TEXT, start INTEGER NOT NULL, end INTEGER, all_day INTEGER NOT NULL DEFAULT 0, where_ TEXT, url TEXT, synced_at INTEGER NOT NULL);
   CREATE TABLE planner_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const item = (/** @type {any} */ o) => {
    const r = { priority: 0, tags: "[]", pinned: 0, state: "open", floating: 0, created: T0 - DAY, updated: T0 - DAY, run_count: 0, paused: 0, title: "", ...o };
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO planner_items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map(c => r[c] ?? null));
  };
  item({ id: "i_alarm", kind: "alarm", title: "Wake up", at: T0 + 20 * HOUR, tz: "Asia/Karachi", wall: "07:00", repeat: JSON.stringify({ every: "day" }), next_fire: T0 + 20 * HOUR });
  item({ id: "i_remind", kind: "reminder", title: "Call the printer", at: T0 + 3 * HOUR, next_fire: T0 + 3 * HOUR, tags: '["office"]', list: "work", priority: 2 });
  item({ id: "i_timer", kind: "timer", title: "", duration_ms: 25 * MIN, at: T0 + 25 * MIN, next_fire: T0 + 25 * MIN });
  item({ id: "i_note", kind: "note", title: "Passcodes", body: "ask Sam" });
  item({ id: "i_todo", kind: "todo", title: "Send the invoice", date: "2026-09-30", due: "2026-09-30" });
  item({ id: "i_done", kind: "todo", title: "Already done", state: "done", done_at: T0 - HOUR });
  item({ id: "i_gone", kind: "reminder", title: "Deleted", at: T0 + HOUR, deleted_at: T0 - HOUR });
  item({ id: "i_event", kind: "event", title: "Retro", at: T0 + 6 * HOUR, duration_ms: 45 * MIN, tz: "Asia/Karachi", where_: "Room 2" });
  item({ id: "i_task", kind: "task", title: "Draft the recap", body: "write it", waits_on: "i_remind" });
  const fire = db.prepare("INSERT INTO planner_firings (id, item, kind, due, ring, missed, state, fired_at, next_ring, acked_at, action, by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  fire.run("f_a", "i_remind", "reminder", T0 - 2 * DAY, 1, 0, "acked", T0 - 2 * DAY, null, T0 - 2 * DAY + MIN, "done", "cli");
  fire.run("f_b", "i_event", "event", T0 - DAY, 1, 1, "missed", T0 - DAY, null, null, null, null);
  fire.run("f_orphan", "i_gone", "reminder", T0 - DAY, 1, 0, "acked", T0 - DAY, null, null, "dismiss", "cli");
  db.prepare("INSERT INTO planner_state (key, value) VALUES (?, ?)").run("settings", JSON.stringify({ timezone: "Asia/Karachi", escalate_after: 7 }));
  db.prepare("INSERT INTO planner_state (key, value) VALUES (?, ?)").run("broken", "{not json");
  db.prepare("INSERT INTO planner_calendar (id, account, event_id, title, start, synced_at) VALUES ('c1', 'alex', 'e1', 'Google copy', ?, ?)").run(T0 + HOUR, T0);
  return db;
}
const tables = (/** @type {DatabaseSync} */ db) => /** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planner_%'").all()).map(r => r.name);
const WANT = { reminder: 4, note: 1, event: 1, task: 1, planner_firing: 2, planner_state: 1 };

async function counts(/** @type {any} */ w, /** @type {any} */ K) {
  const R = w.k.gateway.records;
  const n = async (/** @type {string} */ type) => (await R.query(w.owner, type, { page: { limit: 200 } })).rows.length;
  return { reminder: await n("reminder"), note: await n("note"), event: (await R.query(w.owner, "event", { page: { limit: 200 } })).rows.filter((/** @type {any} */ r) => r.data.source === "vyre").length,
    task: (await K.tasks.list(K.serviceChain(), { doer: K.owner })).filter((/** @type {any} */ t) => t.form && t.form.planner && t.form.planner.legacy_id).length, planner_firing: await n("planner_firing"), planner_state: await n("planner_state") };
}

test("legacy: a planner with its own tables starts, carries what it held into records, and the tables are gone", async t => {
  const db = oldDb();
  const w = await world(t, { store: { db } });
  assert.deepEqual(tables(db), [], "the old tables are dropped");
  const K = w.k.kernelFor({ name: "planner", needs: NEEDS });
  assert.deepEqual(await counts(w, K), WANT);
  // what the person sees: every kind, the repeat rule, the filing, the chain, and the answered ring
  const all = await w.ok("planner.list", { state: "all", limit: 200 });
  const byTitle = Object.fromEntries(all.map((/** @type {any} */ x) => [x.title, x]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["(no title)", "Call the printer", "Draft the recap", "Passcodes", "Send the invoice", "Timer", "Wake up"].filter(x => x !== "(no title)").sort());
  assert.deepEqual(byTitle["Wake up"].repeat, { every: "day" });
  assert.deepEqual([byTitle["Call the printer"].tags, byTitle["Call the printer"].list, byTitle["Call the printer"].priority], [["office"], "work", 2]);
  assert.equal(byTitle["Draft the recap"].waits_on, byTitle["Call the printer"].id, "a chained task follows the new record, not the old id");
  assert.equal(byTitle["Timer"].duration_ms, 25 * MIN, "a timer with no title keeps its length and is called Timer");
  const ev = (await w.ok("planner.agenda", { from: new Date(T0).toISOString(), to: new Date(T0 + DAY).toISOString() })).entries.find((/** @type {any} */ x) => x.title === "Retro");
  assert.deepEqual([ev.where, ev.end - ev.start], ["Room 2", 45 * MIN]);
  const got = await w.ok("planner.get", { item: byTitle["Call the printer"].id });
  assert.ok(got);
  const settings = await w.ok("planner.settings");
  assert.equal(settings.escalate_after, 7, "the settings came across");
  // the next start finds nothing to carry
  assert.equal(await importLegacy({ db, K, log: () => {} }), null);
});

test("legacy: a crash at any write is safe: the tables stay, the re-run carries the rest, and nothing is made twice", async t => {
  // ten writes carry this old planner (seven items, two rings, one setting): a crash before each of them
  for (const limit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const db = oldDb();
    const w = await world(t);
    const real = w.k.kernelFor({ name: "planner", needs: NEEDS });
    let writes = 0;
    const crashing = /** @type {any} */ ({ ...real,
      records: { ...real.records, create: async (/** @type {any[]} */ ...a) => { if (writes++ >= limit) throw new Error("crash"); return real.records.create(...a); }, query: real.records.query, get: real.records.get, update: real.records.update },
      tasks: { ...real.tasks, request: async (/** @type {any[]} */ ...a) => { if (writes++ >= limit) throw new Error("crash"); return real.tasks.request(...a); }, list: real.tasks.list },
    });
    const logs = /** @type {string[]} */ ([]);
    const first = await importLegacy({ db, K: crashing, log: m => logs.push(m) });
    assert.equal(first, null, `limit ${limit}: a crash reports nothing carried`);
    assert.deepEqual(tables(db).sort(), ["planner_calendar", "planner_firings", "planner_items", "planner_state"], `limit ${limit}: the tables stay`);
    const second = await importLegacy({ db, K: real, log: () => {} });
    assert.ok(second, `limit ${limit}: the re-run finishes`);
    assert.deepEqual(await counts(w, real), WANT, `limit ${limit}: exactly one of each after the re-run`);
    assert.deepEqual(tables(db), [], `limit ${limit}: and then the tables go`);
    // a third run, and a run over a copy of the same tables again, add nothing
    const again = oldDb();
    assert.ok(await importLegacy({ db: again, K: real, log: () => {} }));
    assert.deepEqual(await counts(w, real), WANT, `limit ${limit}: the same old rows carried again make no second copy`);
  }
});

test("legacy: a chained task's wait is repointed on the re-run too", async t => {
  const db = oldDb();
  const w = await world(t);
  const real = w.k.kernelFor({ name: "planner", needs: NEEDS });
  // crash after every item is made but before the wait is set: the chain write is an update, which this wrapper refuses once
  let blocked = true;
  const K = /** @type {any} */ ({ ...real, records: { ...real.records, update: async (/** @type {any[]} */ ...a) => { if (blocked) throw new Error("crash"); return real.records.update(...a); }, create: real.records.create, query: real.records.query, get: real.records.get } });
  assert.equal(await importLegacy({ db, K, log: () => {} }), null);
  blocked = false;
  assert.ok(await importLegacy({ db, K: real, log: () => {} }));
  // a planner started over the same records shows what was carried
  const w2 = await world(t, { kernel: w.k });
  const all = await w2.ok("planner.list", { state: "all", limit: 200 });
  assert.equal(all.find((/** @type {any} */ x) => x.title === "Draft the recap").waits_on, all.find((/** @type {any} */ x) => x.title === "Call the printer").id);
  assert.equal(all.length, 6, "no item was made twice");
});
