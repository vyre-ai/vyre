// @ts-check
// The team module's migration chain on an UPGRADED box: running it twice changes nothing, and a database that already holds any later column or table (put there by an earlier build whose
// list was numbered differently) still migrates to the full schema instead of failing with "duplicate column name" and taking the whole module (30 tools) away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../store/index.js";
import { MIGRATIONS } from "./index.js";

const fresh = () => { const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))"); return db; };
const shape = db => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'team_%' ORDER BY name").all());

test("the chain applies once and a second run changes nothing", () => {
  const db = fresh();
  migrate(db, "team", MIGRATIONS);
  const before = shape(db);
  migrate(db, "team", MIGRATIONS);
  assert.equal(shape(db), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM _migrations WHERE module = 'team'").get().n, MIGRATIONS.length);
});

test("an existing box whose database already has a later step's column still reaches the full schema", () => {
  const full = fresh();
  migrate(full, "team", MIGRATIONS);
  const want = shape(full);
  // For each ALTER step i: a box that applied the steps before it, plus the column step i adds (an earlier build numbered it differently), but never recorded step i. (A CREATE TABLE
  // step that was already applied is not tolerated: that stays an error, as core/store's test says.)
  for (let i = 1; i < MIGRATIONS.length; i++) {
    if (!/ALTER TABLE/.test(MIGRATIONS[i]) || /CREATE/.test(MIGRATIONS[i])) continue;
    const db = fresh();
    migrate(db, "team", MIGRATIONS.slice(0, i));
    db.exec("BEGIN"); for (const part of MIGRATIONS[i].split(";")) if (part.trim()) db.exec(part); db.exec("COMMIT");
    migrate(db, "team", MIGRATIONS);
    assert.equal(shape(db), want, `step ${i + 1} already applied`);
  }
});

test("an older box (the list as released before the charter drafts) gets the drafts table and nothing is re-run", () => {
  const db = fresh();
  migrate(db, "team", MIGRATIONS.slice(0, -1));
  migrate(db, "team", MIGRATIONS);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_charter_drafts'").get());
});
