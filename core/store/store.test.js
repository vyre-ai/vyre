// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "./index.js";
import { tempHome } from "../../test/helpers.js";

test("store: every connection is WAL with a busy timeout", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(Number(db.prepare("PRAGMA busy_timeout").get().timeout), 10000);
  db.close();
});

test("store: the database file is private to this user", t => {
  const file = path.join(tempHome(t), "vyre.db");
  const db = open(file);
  db.exec("CREATE TABLE t (x)"); db.exec("INSERT INTO t VALUES (1)");
  for (const f of [file, file + "-wal"]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${path.basename(f)} is readable by others`);
  db.close();
});

test("store: migrations run once each, in order", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const steps = ["CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT)", "ALTER TABLE notes_items ADD COLUMN at INTEGER"];
  migrate(db, "notes", steps);
  migrate(db, "notes", steps);
  const cols = db.prepare("PRAGMA table_info(notes_items)").all().map(c => c.name);
  assert.deepEqual(cols, ["id", "body", "at"]);
  db.close();
});

test("store: a module may not create another module's table", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  assert.throws(() => migrate(db, "notes", ["CREATE TABLE vault_items (id INTEGER)"]), /must start with "notes_"/);
  db.close();
});

test("store: a failed migration rolls back and is not recorded", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  assert.throws(() => migrate(db, "notes", ["CREATE TABLE notes_a (id INTEGER); CREATE TABLE notes_a (id INTEGER)"]));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM _migrations WHERE module='notes'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='notes_a'").get().n, 0, "half a migration was left behind");
  db.close();
});
