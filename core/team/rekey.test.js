// @ts-check
// The upgrade step that moves team rows from a project's short name to its Project record id (0.2.x boxes keyed them by short name).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../store/index.js";
import { MIGRATIONS } from "./index.js";
import { rekeyLegacy } from "./rekey.js";

const HARLOW = "0a7e4b1c-7d4e-4c63-9f3a-2f5b6c7d8e9f", NORTH = "1b8f5c2d-8e5f-4d74-8a4b-3a6c7d8e9f0a";

/** A 0.2.x database: every table filled with rows keyed by short name (and one already keyed by id, as after a partial upgrade). */
function legacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  migrate(db, "team", MIGRATIONS);
  const tm = (/** @type {string} */ agent, /** @type {string} */ project, role = "design") => db.prepare("INSERT INTO team_teammates (agent, project, role, created_at, updated_at) VALUES (?,?,?,1,1)").run(agent, project, role);
  tm("design-harlow-legal", "harlow-legal"); tm("ops-northwind", "northwind", "ops"); tm("review-ghost", "ghost", "review"); tm("qa-harlow-legal", HARLOW, "qa");
  db.prepare("INSERT INTO team_requests (id, teammate, project, from_kind, from_label, text, created_at) VALUES ('r1','design-harlow-legal','harlow-legal','person','cli','hi',1)").run();
  db.prepare("INSERT INTO team_project_settings (project, teammate_default, updated_at) VALUES ('northwind', 0, 1)").run();
  return db;
}
const ids = { "harlow-legal": HARLOW, northwind: NORTH };
const refOf = async (/** @type {string} */ p) => { if (!(p in ids)) throw new Error("no such project"); return { id: /** @type {any} */ (ids)[p] }; };

test("rows keyed by short name are re-keyed to the Project record id; unknown names stay, are logged, and nothing is dropped", async () => {
  const db = legacyDb();
  const logs = /** @type {string[]} */ ([]);
  const r = await rekeyLegacy({ db, refOf, log: m => logs.push(m) });
  assert.deepEqual(r.unknown, ["ghost"]);
  const by = (/** @type {string} */ agent) => /** @type {any} */ (db.prepare("SELECT project FROM team_teammates WHERE agent = ?").get(agent)).project;
  assert.equal(by("design-harlow-legal"), HARLOW);
  assert.equal(by("ops-northwind"), NORTH);
  assert.equal(by("qa-harlow-legal"), HARLOW, "a row already keyed by id is left alone");
  assert.equal(by("review-ghost"), "ghost", "a project Records does not know is not dropped or guessed at");
  assert.equal(/** @type {any} */ (db.prepare("SELECT project FROM team_requests WHERE id = 'r1'").get()).project, HARLOW);
  assert.deepEqual(db.prepare("SELECT project, teammate_default FROM team_project_settings").all().map(x => [x.project, x.teammate_default]), [[NORTH, 0]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ghost/);
  // run again: nothing more to do, and Records learning about the ghost later finishes it
  assert.equal((await rekeyLegacy({ db, refOf })).rekeyed, 0);
  /** @type {any} */ (ids).ghost = "2c9a6d3e-9f60-4e85-9b5c-4b7d8e9f0a1b";
  assert.equal((await rekeyLegacy({ db, refOf })).unknown.length, 0);
  assert.equal(by("review-ghost"), "2c9a6d3e-9f60-4e85-9b5c-4b7d8e9f0a1b");
  delete (/** @type {any} */ (ids)).ghost;
});

test("a duty table keyed by short name is re-keyed too, and the id's own settings row wins over the short name's", async () => {
  const db = legacyDb();
  db.prepare("INSERT INTO team_duties (id, teammate, project, role, watcher, trigger, instruction, created_by, at) VALUES ('d1','design-harlow-legal','harlow-legal','design','w','daily 07:00','x','cli',1)").run();
  db.prepare("INSERT INTO team_project_settings (project, teammate_default, updated_at) VALUES (?, 1, 2)").run(NORTH);
  await rekeyLegacy({ db, refOf });
  assert.equal(/** @type {any} */ (db.prepare("SELECT project FROM team_duties WHERE id = 'd1'").get()).project, HARLOW);
  assert.deepEqual(db.prepare("SELECT project, teammate_default FROM team_project_settings").all().map(x => [x.project, x.teammate_default]), [[NORTH, 1]]);
});
