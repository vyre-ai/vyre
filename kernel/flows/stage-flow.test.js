// @ts-check
// A Playbook stage is a Flow (kernel/flows/stage-flow.js): its trigger is the stage, its steps are the stage's to-dos with their three slots and the move on, and reading the stage back gives what was put in.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageFlow, stageOf, nextOf, stageKey, isStageFlow, stageFlowProblems } from "./stage-flow.js";
import { checkFlow } from "./schema.js";
import { compileFlow } from "./compile.js";

const OPEN = {
  name: "Open", owner: "role:manager",
  tasks: [
    { title: "Draft the reply", doer: "teammate:research", output: { kind: "note" }, how: "assistant", reviewer: { who: "person:per_bob", instructions: "Check the tone" }, due_offset_ms: 86_400_000, checklist: [{ say: "The title is set", check: { field: "title != \"\"" } }] },
    { title: "Check the details", doer: "person:per_bob", output: { kind: "note" }, approver: { who: "person:per_alex" }, depends_on: ["Draft the reply"] },
    { title: "Tidy up", doer: "group:manager", output: { kind: "note" }, required: false },
  ],
};
const cat = { space: "spc_test", types: { ticket: { name: "ticket", label: "Ticket", fields: [], stages: [OPEN, { name: "Closed" }] } }, actions: {} };

test("a stage is a Flow: its trigger is the stage, one task step per to-do with its slots, and a last step that moves the record on", () => {
  const f = stageFlow({ type: "ticket", typeLabel: "Ticket", stage: OPEN, next: "Closed", kit: "sample" });
  assert.ok(isStageFlow(f));
  assert.deepEqual(f.trigger, { on: "stage", type: "ticket", stage: "Open" });
  assert.equal(f.label, "Ticket: Open");
  assert.deepEqual(f.steps.map((/** @type {any} */ s) => [s.id, s.kind]), [["task_1", "assign"], ["task_2", "assign"], ["task_3", "assign"], ["move", "stage"]]);
  assert.deepEqual(f.steps[0].reviewer, { who: "person:per_bob", instructions: "Check the tone" }, "Reviewer rides on the step");
  assert.deepEqual(f.steps[1].approver, { who: "person:per_alex" }, "Approver rides on the step");
  assert.equal(f.steps[0].to, "teammate:research", "Assigned is the step's to");
  assert.equal(f.steps[0].await, true, "the stage waits for a required to-do");
  assert.equal(f.steps[2].await, undefined, "and not for an optional one");
  assert.deepEqual(f.steps[1].task, { depends_on: ["Draft the reply"] }, "what the builder has no field for rides on the step as task");
  assert.equal(nextOf(f), "Closed");
  assert.equal(f.playbook.key, stageKey({ type: "ticket", stage: "Open" }));
  assert.equal(f.playbook.owner, "role:manager");
  assert.deepEqual(checkFlow(f), [], "a stored Flow like any other");
  const c = compileFlow(f, /** @type {any} */ (cat));
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.deepEqual(c.effects.assigns.map((/** @type {any} */ a) => a.to), ["teammate:research", "person:per_bob", "group:manager"]);
});

test("reading the stage back from its Flow gives the stage that was put in, so the Flow builder and the Playbook page edit one thing", () => {
  const f = stageFlow({ type: "ticket", stage: OPEN, next: "Closed" });
  const back = stageOf(f);
  assert.equal(back.name, "Open");
  assert.equal(back.owner, "role:manager");
  assert.deepEqual(back.tasks, OPEN.tasks);
  // a Playbook template's stage is its own Flow per version: a running project keeps the version it began with
  const t = stageFlow({ type: "project", stage: OPEN, next: "Closed", template: "tpl_sample", version: 2 });
  assert.equal(t.playbook.key, "template:tpl_sample:2:Open");
  assert.notEqual(t.name, f.name);
  // the last stage has nowhere to go, and a stage with no to-dos never moves on by itself
  assert.equal(nextOf(stageFlow({ type: "ticket", stage: OPEN, next: null })), null);
  assert.deepEqual(stageFlow({ type: "ticket", stage: { name: "Closed" }, next: "Archived" }).steps, []);
});

test("a stage Flow stays a stage: other steps, another trigger and a to-do with nobody to do it are refused in plain words", () => {
  const f = stageFlow({ type: "ticket", stage: OPEN, next: "Closed" });
  const said = (/** @type {any} */ g) => stageFlowProblems(g).map(p => p.message).join("\n");
  assert.match(said({ ...f, steps: [{ id: "x", kind: "wait", for_ms: 60_000 }, ...f.steps] }), /made of to-dos/);
  assert.match(said({ ...f, trigger: { on: "manual" } }), /starts when a ticket enters Open/);
  assert.match(said({ ...f, steps: [{ ...f.steps[0], to: "somebody" }, ...f.steps.slice(1)] }), /a to-do goes to/);
  assert.match(said({ ...f, steps: [...f.steps.slice(0, 3), { ...f.steps[3], id: "later" }] }), /last step, called move/);
  assert.match(said({ ...f, steps: [{ ...f.steps[0], reviewer: "person:per_bob" }, ...f.steps.slice(1)] }), /reviewer is \{ who/);
});
