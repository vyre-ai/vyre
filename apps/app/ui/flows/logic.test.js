import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, flowSentence, toDefinition, draftProblems, newStep, removeStep, moveStep, firstStageTasks, stepSummary } from "./logic.js";
import { SAMPLE_OPTIONS as O, REFUND_DRAFT, ATP_DRAFT } from "../../screens/flows/starters.js";

test("the refund starter reads as one sentence", () => {
  assert.equal(flowSentence(REFUND_DRAFT, O), "When a record is created in RefundRequests, create a RefundRequests record from the details it started with, then hand it to the Refunds agent with your instructions.");
});

test("the ATP starter says what it does", () => {
  const s = flowSentence(ATP_DRAFT, O);
  assert.match(s, /^When a person signs up, create a Client record/);
  assert.match(s, /start a project from the ATP template and link it to the new Client record/);
});

for (const d of [REFUND_DRAFT, ATP_DRAFT]) {
  test(`${d.name} is a Flow the box accepts`, () => {
    assert.deepEqual(draftProblems(d, O), []);
    const r = checkFlow(toDefinition(d));
    assert.deepEqual(r, [], JSON.stringify(r));
  });
}

test("every step kind of the palette stores as a valid step", () => {
  const d = { name: "All kinds", trigger: { kind: "stage", type: "matter", stage: "Drafting" }, steps: [] };
  for (const kind of ["create", "project", "agent", "assign", "email", "ask", "update"]) {
    const s = newStep(kind, d, O);
    Object.assign(s, { type: s.type || "matter", instructions: "x", title: "t", to: s.kind === "email" ? "a@b.co" : s.to, body: "b", field: "status", value: "Open", agent: "refunds" });
    d.steps.push(s);
  }
  const r = checkFlow(toDefinition(d));
  assert.deepEqual(r, [], JSON.stringify(r));
});

test("problems say what is missing in words", () => {
  const d = { name: "", trigger: { kind: "created" }, steps: [{ id: "agent1", kind: "agent", agent: "refunds", instructions: "" }] };
  assert.deepEqual(draftProblems(d, O), ["Give the Flow a name.", "Choose the kind of record that starts it.", "Step 1: Tell the agent what to do with it."]);
});

test("removing a step repoints what used it, moving swaps neighbours", () => {
  const steps = removeStep(ATP_DRAFT.steps, "create1");
  assert.equal(steps.find((s) => s.id === "project2").link, "trigger");
  assert.deepEqual(moveStep([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveStep([1, 2, 3], 0, -1), [1, 2, 3]);
});

test("a project step shows what its first stage hands out", () => {
  const t = firstStageTasks(O.templates[0], O);
  assert.equal(t.stage, "Kickoff");
  assert.deepEqual(t.tasks.map((x) => x.who), ["the project lead", "the Paralegal team", "the Research agent"]);
  assert.equal(stepSummary({ id: "p", kind: "project", template: "tpl_atp" }, O), "Start a project from the ATP template");
});

test("a stored Flow opens as a draft and saves back the same", () => {
  for (const d of [REFUND_DRAFT, ATP_DRAFT]) {
    const stored = toDefinition(d);
    const back = fromDefinition(stored);
    assert.equal(back.steps.some((s) => s.kind === "advanced"), false, "every step the palette wrote is understood");
    assert.deepEqual(toDefinition(back), stored);
  }
});

test("a step the palette cannot say is kept as it was", () => {
  const stored = { ...toDefinition(REFUND_DRAFT), concurrency: 2, steps: [...toDefinition(REFUND_DRAFT).steps, { id: "look", kind: "find", type: "client", where: "record.x == 1" }] };
  const d = fromDefinition(stored);
  assert.equal(d.steps.at(-1).kind, "advanced");
  assert.equal(stepSummary(d.steps.at(-1), O), "Advanced step (find)");
  assert.deepEqual(toDefinition(d), stored);
});

test("a stored group rides along", () => {
  const d = fromDefinition({ ...toDefinition(REFUND_DRAFT), group: "Money" });
  assert.equal(d.group, "Money");
  assert.equal(toDefinition(d).group, "Money");
});
