import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardColumns, changeCount, versionBar, taskCard, doneRule, TEMPLATES_LABEL, initialsOf } from "./board.ts";

const people = [{ id: "alex", name: "Alex Rivera" }];
const agents = [{ id: "research", name: "Research" }];
const body = () => ({
  name: "Estate plan", noun: { one: "Matter", many: "Matters" }, roles: [{ role: "attorney" }, { role: "paralegal" }],
  stages: [
    { name: "Opening", groups: [{ name: "Documents" }], tasks: [
      { title: "Conflict check", doer: "role:paralegal", output: { kind: "note" }, due_offset_ms: 86_400_000, group: "Documents", checker: "role:attorney", followers: ["person:alex"] },
      { title: "Welcome email", doer: "teammate:research", output: { kind: "note" }, needs_yes: ["sending anything to the family"], required: false },
    ] },
    { name: "Review", done_when: "sign_off", sign_off: "role:attorney", tasks: [{ title: "Review", doer: "lead", output: { kind: "decision" } }] },
    { name: "Done" },
  ],
});

test("the screen's name is one constant", () => { assert.equal(typeof TEMPLATES_LABEL, "string"); assert.ok(TEMPLATES_LABEL.length > 0); });

test("a board has one column per stage, each with its tasks as cards and its rule in words", () => {
  const cols = boardColumns(body(), people, agents);
  assert.deepEqual(cols.map((c) => c.name), ["Opening", "Review", "Done"]);
  assert.deepEqual(cols.map((c) => c.tasks.length), [2, 1, 0]);
  assert.equal(cols[0].rule, "The tasks needed to finish are done");
  assert.equal(cols[1].rule, "The attorney signs it off");
  assert.equal(cols[2].last, true);
  assert.deepEqual(cols.map((c) => c.index), [0, 1, 2]);
});

test("with no stages there is one column of tasks and no rule", () => {
  const cols = boardColumns({ ...body(), stage_mode: "none" }, people, agents);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].name, "Tasks");
  assert.equal(cols[0].rule, "");
});

test("a task card says who does it, who approves, who follows, when it is due, and what waits for a yes", () => {
  const b = body();
  const a = taskCard(b.stages[0].tasks[0], b, people, agents);
  assert.deepEqual([a.title, a.assignee.label, a.assignee.kind, a.approver.label, a.followers.map((f) => f.label), a.due, a.group, a.optional], ["Conflict check", "The paralegal", "role", "The attorney", ["Alex Rivera"], "1 day", "Documents", false]);
  const c = taskCard(b.stages[0].tasks[1], b, people, agents);
  assert.deepEqual([c.assignee.label, c.assignee.kind, c.approver, c.needsYes, c.optional, c.due], ["Research (assistant)", "agent", null, "sending anything to the family", true, ""]);
  assert.equal(taskCard(b.stages[1].tasks[0], b, people, agents).assignee.label, "The project lead");
});

test("the rule of a stage in words", () => {
  assert.equal(doneRule({ name: "A", done_when: "all" }, { name: "x", stages: [] }), "Every task is done");
  assert.equal(doneRule({ name: "A" }, { name: "x", stages: [] }), "The tasks needed to finish are done");
  assert.equal(doneRule({ name: "A", done_when: "sign_off" }, { name: "x", stages: [] }), "Someone signs it off");
});

test("how many things differ from the live version: stages, tasks and settings each count once", () => {
  const live = body();
  assert.equal(changeCount(live, live), 0);
  const e = body(); e.stages[0].tasks[0].title = "Conflict check done";
  assert.equal(changeCount(live, e), 1);
  const f = body(); f.stages[0].tasks.pop(); f.stages.push({ name: "Archive" });
  assert.equal(changeCount(live, f), 2);
  const g = body(); g.noun = { one: "Case", many: "Cases" };
  assert.equal(changeCount(live, g), 1);
  assert.equal(changeCount(null, live), 0, "nothing to compare with");
});

test("the version bar: what is live, what changed, whether there is anything to publish", () => {
  assert.deepEqual(versionBar({ live: 1, changes: 3 }), { line: "Live: v1 · Draft changes: 3", canPublish: true });
  assert.deepEqual(versionBar({ live: 2, changes: 0 }), { line: "Live: v2 · No changes", canPublish: false });
  assert.deepEqual(versionBar({ live: null, changes: 0 }), { line: "Not live yet", canPublish: true });
  assert.deepEqual(versionBar({ live: null, changes: 4 }), { line: "Not live yet · Draft changes: 4", canPublish: true });
});

test("initials for an avatar", () => {
  assert.equal(initialsOf("Alex Rivera"), "AR");
  assert.equal(initialsOf("The paralegal"), "P");
  assert.equal(initialsOf("Research (assistant)"), "R");
  assert.equal(initialsOf(""), "?");
});

test("a template's card: its name, what its projects are called, its stage strip, its counts and the verb on its button", async () => {
  const { cardOf } = await import("./board.ts");
  const row = { template: "tpl_e", name: "Estate plan", live: 2, latest: 3, versions: 3, owner: null, tags: [], noun: { one: "Matter", many: "Matters" } };
  const c = cardOf(row, body(), 4);
  assert.deepEqual([c.name, c.projects, c.start, c.stages, c.counts, c.status, c.group], ["Estate plan", "Matters", "Start a matter", ["Opening", "Review", "Done"], "3 stages · 3 tasks · 4 running", "v2", "Live"]);
  const d = cardOf({ ...row, live: null, noun: undefined, name: "Onboarding" }, { ...body(), noun: undefined, stage_mode: "none" }, 0);
  assert.deepEqual([d.projects, d.start, d.stages, d.counts, d.status, d.group], ["Projects", "Start a project", [], "3 tasks", "Draft v3", "Drafts"]);
  assert.equal(cardOf(row, null, 1).counts, "1 running", "before the body is read there is only what the list knows");
});

test("the list's search and filter: by name or what its projects are called, and Live or Draft", async () => {
  const { filterRows } = await import("./board.ts");
  const rows = [
    { template: "a", name: "Estate plan", live: 1, latest: 1, versions: 1, owner: null, tags: [], noun: { one: "Matter", many: "Matters" } },
    { template: "b", name: "Ad campaign", live: null, latest: 1, versions: 1, owner: null, tags: [], noun: { one: "Campaign", many: "Campaigns" } },
    { template: "c", name: "ATP", live: 2, latest: 2, versions: 2, owner: null, tags: [] },
  ];
  assert.deepEqual(filterRows(rows, "", "all").map((r) => r.template), ["a", "b", "c"]);
  assert.deepEqual(filterRows(rows, "matt", "all").map((r) => r.template), ["a"]);
  assert.deepEqual(filterRows(rows, "AD", "all").map((r) => r.template), ["b"]);
  assert.deepEqual(filterRows(rows, "", "live").map((r) => r.template), ["a", "c"]);
  assert.deepEqual(filterRows(rows, "", "draft").map((r) => r.template), ["b"]);
  assert.deepEqual(filterRows(rows, "zzz", "all"), []);
});
