// @ts-check
// An upgraded box's old planner tables move into Records once: each item once, a failure retried at the next start, a deleted item and the calendar cache left behind. The released
// steps themselves are pinned by test/migrations-append-only.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, importLegacy, shapeLegacy } from "./legacy.js";
import { migrate } from "../store/index.js";

const legacyDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  migrate(db, "planner", MIGRATIONS);
  const add = db.prepare("INSERT INTO planner_items (id, kind, title, body, tags, repeat, pinned, state, at, tz, created, updated, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)");
  add.run("pl_a", "reminder", "Call Dana", "about the estate", '["clients"]', null, 1, 1_800_000_000_000, "Asia/Karachi", 100, 100, null);
  add.run("pl_b", "todo", "File the motion", null, "[]", '{"every":"week"}', 0, null, null, 200, 200, null);
  add.run("pl_c", "note", "Removed", null, "[]", null, 0, null, null, 300, 300, 999);
  db.prepare("INSERT INTO planner_calendar (id, account, event_id, title, start, synced_at) VALUES ('c1', 'a', 'e1', 'Meeting', 1, 1)").run();
  return db;
};

test("planner legacy: the list keeps its five released steps and adds one at the end that records what moved", () => {
  assert.equal(MIGRATIONS.length, 6);
  assert.match(MIGRATIONS[5], /CREATE TABLE planner_moved/);
});

test("planner legacy: each old item moves once, shaped for the planner; a deleted one and the calendar cache stay; a failure is tried again", async () => {
  const db = legacyDb();
  /** @type {any[]} */ const made = [];
  let fail = true;
  const make = async (/** @type {any} */ item) => { if (item.title === "File the motion" && fail) throw new Error("the store is busy"); made.push(item); return { id: `new_${made.length}` }; };
  assert.equal(await importLegacy(db, make, () => 5000), 1, "one moved, one failed");
  assert.deepEqual(made.map(m => m.title), ["Call Dana"]);
  assert.deepEqual([made[0].tags, made[0].pinned, made[0].tz, made[0].at], [["clients"], true, "Asia/Karachi", 1_800_000_000_000], "JSON parsed, flags as booleans");
  fail = false;
  assert.equal(await importLegacy(db, make, () => 6000), 1, "the failed one is tried again, the moved one is not");
  assert.deepEqual(made.map(m => m.title), ["Call Dana", "File the motion"]);
  assert.deepEqual(made[1].repeat, { every: "week" });
  assert.equal(await importLegacy(db, make, () => 7000), 0, "nothing is made twice");
  assert.deepEqual(db.prepare("SELECT id FROM planner_moved ORDER BY id").all().map(r => r.id), ["pl_a", "pl_b"]);
  assert.equal(shapeLegacy({ kind: "note", title: "x", created: 1, updated: 1, state: "open" }).tags.length, 0);
});

test("planner legacy: a database that never had the planner's tables has nothing to move", async () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(await importLegacy(db, async () => ({ id: "x" }), () => 1), 0);
});
