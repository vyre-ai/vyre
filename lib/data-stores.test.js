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
  db.exec("CREATE TABLE events (type TEXT); CREATE TABLE _migrations (n INT); CREATE TABLE threads_rows (id INT)");
  db.exec("INSERT INTO events VALUES ('system.started'); INSERT INTO _migrations VALUES (1)");
  const ev = [...BOOT_KERNEL_EVENTS].map(type => ({ type }));
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
  db.exec("DELETE FROM threads_rows; INSERT INTO events VALUES ('thread.sent')");
  assert.equal((await holds(mk()))["the modules' own data"], true);
  db.exec("DELETE FROM events WHERE type = 'thread.sent'");
  assert.equal((await holds(mk()))["the modules' own data"], false);
  assert.ok(SYSTEM_TABLES.has("memory_meta"));
  // files
  fs.mkdirSync(path.join(d, "drive")); fs.writeFileSync(path.join(d, "drive", "a.txt"), "x");
  assert.equal((await holds(mk()))["the files in this server's home"], true);
});
