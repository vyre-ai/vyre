// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Access, accessMigration, allows, LEVELS } from "./access.js";

test("access: one shape for a thing's Can use and Can edit, by person or role, with who added it", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(accessMigration("agents_access"));
  const a = new Access(db, "agents_access");
  assert.equal(a.level("a1", { person: "per_x" }), "none");
  a.set("a1", { kind: "person", subject: "per_x", level: "use" }, "per_owner");
  a.set("a1", { kind: "role", subject: "paralegal", level: "edit" }, "per_owner");
  assert.equal(a.level("a1", { person: "per_x" }), "use");
  assert.equal(a.level("a1", { person: "per_y", role: "paralegal" }), "edit", "a role reaches everyone in it");
  assert.equal(a.level("a1", { person: "per_x", role: "paralegal" }), "edit", "the most she was given");
  assert.equal(a.level("a2", { person: "per_x" }), "none", "another thing is another thing");
  assert.deepEqual(a.list("a1").map(r => [r.kind, r.subject, r.level, r.by]), [["person", "per_x", "use", "per_owner"], ["role", "paralegal", "edit", "per_owner"]]);
  a.set("a1", { kind: "person", subject: "per_x", level: null }, "per_owner");
  assert.equal(a.level("a1", { person: "per_x" }), "none");
  assert.throws(() => a.set("a1", { kind: "group", subject: "x", level: "use" }, null), /person or a role/);
  assert.throws(() => a.set("a1", { kind: "person", subject: "per_x", level: "own" }, null), /use or edit/);
  a.clear("a1");
  assert.deepEqual(a.list("a1"), []);
});

test("access: edit includes use, per kind; an unknown kind or level allows nothing", () => {
  assert.ok(allows("agent", "edit", "agents.use") && allows("agent", "edit", "agents.edit"));
  assert.ok(allows("agent", "use", "agents.use") && !allows("agent", "use", "agents.edit"));
  assert.ok(allows("flow", "use", "flows.run") && !allows("flow", "use", "flows.define") && allows("flow", "edit", "flows.define"));
  assert.ok(!allows("nothing", "edit", "x") && !allows("agent", "own", "agents.use"));
  assert.deepEqual(Object.keys(LEVELS).sort(), ["agent", "flow", "project", "vault"]);
});
