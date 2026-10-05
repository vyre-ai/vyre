// @ts-check
// An upgraded box has applied the four released steps; the hub's fifth keeps every project and turns its home into a per-machine folder row.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./projects.js";

test("the fifth step moves each project's home into projects_folders, drops the home column and the access tables, and loses no project", () => {
  assert.equal(MIGRATIONS.length, 5, "four released steps and the hub's");
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
  db.prepare("INSERT INTO projects_projects (slug, name, home, spec, at) VALUES (?,?,?,?,?)").run("rivera", "Rivera", "/home/alex/Work/rivera", "{}", 1);
  db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES ('a1','rivera','kit','granted','p',1)").run();
  db.exec(MIGRATIONS[4]);
  assert.deepEqual(db.prepare("SELECT slug, name FROM projects_projects").all().map(r => ({ ...r })), [{ slug: "rivera", name: "Rivera" }]);
  assert.deepEqual(db.prepare("SELECT path, project, kind FROM projects_folders").all().map(r => ({ ...r })), [{ path: "/home/alex/Work/rivera", project: "rivera", kind: "home" }]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('projects_access', 'projects_access_seeded')").all().length, 0);
  assert.throws(() => db.prepare("SELECT home FROM projects_projects").all(), /no such column/);
  // a fresh box runs all five and ends the same
  const fresh = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) fresh.exec(m);
  assert.equal(fresh.prepare("SELECT count(*) AS n FROM projects_folders").get()?.n, 0);
});
