import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { newChoices, duplicateBody, rowState, projectNoun } from "./use.ts";

const rows = [
  { template: "tpl_estate", name: "Estate plan", live: 2, latest: 3, versions: 3, owner: "a", tags: [], noun: { one: "Matter", many: "Matters" } },
  { template: "tpl_launch", name: "Launch", live: 1, latest: 1, versions: 1, owner: "a", tags: [] },
  { template: "tpl_draft", name: "Only a draft", live: null, latest: 1, versions: 1, owner: "a", tags: [] },
];

test("New project offers each live template by what its projects are called, then a blank project", () => {
  assert.deepEqual(newChoices(rows).map((c) => c.label), ["New matter", "New launch", "New blank project"]);
  assert.deepEqual(newChoices(rows).map((c) => c.template), ["tpl_estate", "tpl_launch", null]);
  assert.deepEqual(newChoices([]).map((c) => c.label), ["New blank project"]);
});

test("a template with no noun is called by its own name, lower-cased; a draft is not offered", () => {
  assert.equal(newChoices(rows).some((c) => c.template === "tpl_draft"), false);
});

test("a copy of a template has its own name and keeps the stages", () => {
  const b = { name: "Estate plan", noun: { one: "Matter", many: "Matters" }, stages: [{ name: "A" }, { name: "B" }] };
  const c = duplicateBody(b);
  assert.equal(c.name, "Estate plan (copy)");
  assert.deepEqual(c.stages, b.stages);
  assert.notEqual(c.stages, b.stages);
  assert.equal(duplicateBody(c).name, "Estate plan (copy 2)");
});

test("a row says whether it is live, a draft or archived, in a word", () => {
  assert.equal(rowState(rows[0]), "Live");
  assert.equal(rowState(rows[2]), "Draft");
  assert.equal(rowState({ ...rows[2], archived: true }), "Archived");
});

test("a project's page names its kind from the template it started with, else Project", () => {
  assert.equal(projectNoun({ template_snapshot: JSON.stringify({ noun: { one: "Matter", many: "Matters" }, stages: [] }) }), "Matter");
  assert.equal(projectNoun({ template_snapshot: JSON.stringify({ name: "Launch", stages: [] }) }), "Launch");
  assert.equal(projectNoun({ template_snapshot: "not json" }), "Project");
  assert.equal(projectNoun({}), "Project");
});

test("only the owner and an admin are offered the buttons that make or copy a template", async () => {
  const { mayMakeTemplates } = await import("./use.ts");
  assert.deepEqual(["owner", "admin", "manager", "member", "temp", "", undefined, null].map(mayMakeTemplates), [true, true, false, false, false, false, false, false]);
});
