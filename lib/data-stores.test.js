import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDataStores, SYSTEM_TABLES, BOOT_KERNEL_EVENTS } from "./data-stores.js";

function home(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ds-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, "kernel"), { recursive: true });
  fs.writeFileSync(path.join(d, "config.json"), "{}"); fs.writeFileSync(path.join(d, "kernel", "space.json"), "{}");
  return d;
}
const holds = async (list) => Object.fromEntries(await Promise.all((await list()).map(async s => [s.name, await s.holds()])));

test("an empty box reports no data; each kind of data, and anything unknown or unanswered, counts as data", async t => {
  const d = home(t);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (n INT); CREATE TABLE threads_rows (id INT)");
  db.exec("INSERT INTO _migrations VALUES (1)");
  // The bus is the kernel's log now: a bus event is a log entry marked `legacy`; `system.started` is bookkeeping.
  const bus = type => ({ type, data: { legacy: 1 } });
  const ev = [...BOOT_KERNEL_EVENTS].map(type => ({ type }));
  const mkBus = (...types) => mk({ kernelEvents: () => [...ev, bus("system.started"), ...types.map(bus)] });
  const mk = (over = {}) => createDataStores({ home: d, db, kernelEvents: () => ev, vaultHolds: () => false, ...over });
  const all = async (list) => Object.values(await holds(list));
  assert.deepEqual(await all(mk()), [false, false, false, false], "nothing of the person's");
  // the vault
  assert.equal((await holds(mk({ vaultHolds: () => true })))["the vault and sealed values"], true);
  assert.equal((await holds(mk({ vaultHolds: () => undefined })))["the vault and sealed values"], undefined, "an unanswered read is not 'empty'");
  assert.notEqual((await holds(createDataStores({ home: d, db, kernelEvents: () => ev })))["the vault and sealed values"], false, "no vault read at all is not 'empty'");
  // records
  assert.equal((await holds(mk({ kernelEvents: () => [...ev, { type: "contact.created" }] })))["the Space's records, events and grants"], true);
  assert.notEqual((await holds(createDataStores({ home: d, db, vaultHolds: () => false })))["the Space's records, events and grants"], false, "no log handed in: unknown");
  // module data: an unknown table with a row, and an activity event that is not bookkeeping
  db.exec("INSERT INTO threads_rows VALUES (1)");
  assert.equal((await holds(mk()))["the modules' own data"], true);
  db.exec("DELETE FROM threads_rows");
  assert.equal((await holds(mkBus("thread.sent")))["the modules' own data"], true);
  assert.equal((await holds(mkBus()))["the modules' own data"], false);
  assert.equal((await holds(mkBus()))["the Space's records, events and grants"], false, "bus events are the modules' activity, not the Space's records");
  assert.ok(SYSTEM_TABLES.has("memory_meta"));
  // files
  fs.mkdirSync(path.join(d, "drive")); fs.writeFileSync(path.join(d, "drive", "a.txt"), "x");
  assert.equal((await holds(mk()))["the files in this server's home"], true);
});

test("a second Space's records in the shared event table count as data, and the recall index's shadow table does not hide the turns", async t => {
  const d = home(t);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (type TEXT); CREATE TABLE kernel_events (seq INTEGER PRIMARY KEY, space TEXT NOT NULL, event TEXT, type TEXT)");
  const own = [...BOOT_KERNEL_EVENTS];
  own.forEach((type, i) => db.prepare("INSERT INTO kernel_events (space, event, type) VALUES (?,?,?)").run("home", "{}", type));
  const mk = () => createDataStores({ home: d, db, kernelEvents: () => own.map(type => ({ type })), vaultHolds: () => false });
  const records = async () => (await holds(mk()))["the Space's records, events and grants"];
  assert.equal(await records(), false, "bookkeeping only");
  // the probe: the home's own log is clean, a hosted Space has a record in the same table
  db.prepare("INSERT INTO kernel_events (space, event, type) VALUES (?,?,?)").run("spc_harlowestateplan", "{}", "record.created");
  assert.equal(await records(), true);
  assert.equal(await holds(mk()).then(h => h["the modules' own data"]), false, "it is the records store that answers, not a module table");
  // a table that cannot be read is unknown, never empty
  const bad = new DatabaseSync(":memory:");
  bad.exec("CREATE TABLE kernel_events (seq INTEGER PRIMARY KEY, space TEXT)");
  assert.equal((await holds(createDataStores({ home: d, db: bad, kernelEvents: () => [], vaultHolds: () => false })))["the Space's records, events and grants"], undefined);
  // recall index: the shadow table alone is bookkeeping, its content table is not
  const r = new DatabaseSync(":memory:");
  r.exec("CREATE TABLE recall_turns_data (id INTEGER PRIMARY KEY, block BLOB); INSERT INTO recall_turns_data VALUES (1, x'00'); CREATE TABLE recall_turns_content (id INTEGER PRIMARY KEY, c0 TEXT)");
  const mod = async () => (await holds(createDataStores({ home: d, db: r, kernelEvents: () => [], vaultHolds: () => false })))["the modules' own data"];
  assert.equal(await mod(), false);
  r.exec("INSERT INTO recall_turns_content VALUES (1, 'Harlow intake call')");
  assert.equal(await mod(), true);
});

test("the kernel's own bookkeeping is not the person's data, but an agent they made, and any file outside the vault's folder, is", async t => {
  const d = home(t);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kernel_flags (name TEXT, value TEXT); INSERT INTO kernel_flags VALUES ('counts:contact:name', '3')");
  db.exec("CREATE TABLE kernel_ftf_data (id INT); INSERT INTO kernel_ftf_data VALUES (1)");
  db.exec("CREATE TABLE agents_agents (name TEXT, builtin INT); INSERT INTO agents_agents VALUES ('engineer', 1)");
  fs.mkdirSync(path.join(d, "kernel", "seal", "values"), { recursive: true });
  fs.writeFileSync(path.join(d, "kernel", "seal", "values", "seal_abc.json"), "{}");
  fs.writeFileSync(path.join(d, "wink-keys.json.device"), "{}");
  const ev = [...BOOT_KERNEL_EVENTS].map(type => ({ type }));
  const list = () => createDataStores({ home: d, db, kernelEvents: () => [...ev, { type: "membership.read" }], vaultHolds: () => false });
  assert.deepEqual(Object.values(await holds(list())), [false, false, false, false], "counters, index structure, the shipped agent, the box's pairing key and the sealer's own files are not data");
  db.exec("INSERT INTO agents_agents VALUES ('my-helper', 0)");
  assert.equal((await holds(list()))["the modules' own data"], true, "an agent the person made is");
  fs.writeFileSync(path.join(d, "notes.txt"), "x");
  assert.equal((await holds(list()))["the files in this server's home"], true);
});
