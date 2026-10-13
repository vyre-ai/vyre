import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, sourceHash } from "../../../../kernel/flows/schema.js";
import { findStep, flat, mapStep, moveDeep, canMove, addTo, removeDeep } from "./tree.js";
import { FORMULA_HASH, FORMULA_SOURCE, approverChoices, fromDefinition, flowSentence, toDefinition, draftProblems, newStep, removeStep, moveStep, firstStageTasks, stepSummary } from "./logic.js";
import { SAMPLE_OPTIONS as O, REFUND_DRAFT, ATP_DRAFT } from "../../screens/flows/starters.js";

test("the refund starter reads as one sentence", () => {
  assert.equal(flowSentence(REFUND_DRAFT, O), "When the form refund-request is submitted, create a RefundRequests record with Client, Email, Amount, Reason, then hand it to the Refunds agent with your instructions.");
});

test("the ATP starter says what it does", () => {
  const s = flowSentence(ATP_DRAFT, O);
  assert.match(s, /^When a person signs up, create a Client record with Name, Email/);
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
  const d = { name: "", trigger: { kind: "created" }, steps: [{ id: "agent1", kind: "agent", agent: "refunds", record: "trigger", instructions: "" }] };
  assert.deepEqual(draftProblems(d, O), ["Give the Flow a name.", "Choose the object that starts it.", "Step 1: Tell the agent what to do with it."]);
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
  const stored = { ...toDefinition(REFUND_DRAFT), concurrency: 2, steps: [...toDefinition(REFUND_DRAFT).steps, { id: "look", kind: "classify", input: { expr: "trigger.a + trigger.b" }, labels: ["x", "y"] }] };
  const d = fromDefinition(stored);
  assert.equal(d.steps.at(-1).kind, "advanced");
  assert.equal(stepSummary(d.steps.at(-1), O), "Advanced step (classify)");
  assert.deepEqual(toDefinition(d), stored);
});

test("a stored group rides along", () => {
  const d = fromDefinition({ ...toDefinition(REFUND_DRAFT), group: "Money" });
  assert.equal(d.group, "Money");
  assert.equal(toDefinition(d).group, "Money");
});

test("a record trigger is the type's own event, and a step reads the record from the event", () => {
  const d = { name: "On refund", trigger: { kind: "created", type: "refund_requests" }, steps: [{ id: "agent1", kind: "agent", agent: "refunds", title: "t", instructions: "x", record: "trigger" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.trigger, { on: "event", event: "refund_requests.created" });
  assert.deepEqual(def.steps[0].record, { expr: "event.subject" });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
});

test("braces take a value from what started the Flow and come back as braces", () => {
  const d = { name: "Mail", trigger: { kind: "signup" }, steps: [{ id: "email1", kind: "email", to: "{email}", subject: "Hello", body: "Hi {name}" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].input.to, { expr: "trigger.email" });
  assert.equal(def.steps[0].input.body, "Hi {name}");
  assert.equal(fromDefinition(def).steps[0].to, "{email}");
});

test("an approver, followers and their notes round-trip, and an agent may approve", () => {
  const d = { name: "People", trigger: { kind: "manual" }, steps: [{ id: "assign1", kind: "assign", to: "role:attorney", title: "Review", brief: "Look at [[record:this]]", checker: "role:manager", followers: ["person:ana", "agent:research"], approverNote: "Check the sums", followerNote: "FYI" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].followers, ["person:ana", "teammate:research"]);
  assert.deepEqual(def.steps[0].notes, { approver: "Check the sums", followers: "FYI" });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.match(stepSummary(d.steps[0], O), /checked by the Manager team, followed by 2 others/);
  assert.equal(approverChoices(O).some(([v]) => v.startsWith("agent:")), true);
  const lowly = { ...O, agents: [{ name: "x", label: "X" }, { name: "y", label: "Y", staff: false }] };
  assert.equal(approverChoices(lowly).some(([v]) => v.startsWith("agent:")), false, "an agent not made by an owner or admin is not offered");
});

test("an agent as the approver is stored as a teammate checker and comes back", () => {
  const d = { name: "Review", trigger: { kind: "manual" }, steps: [{ id: "assign1", kind: "assign", to: "agent:intake", title: "Draft", checker: "agent:research" }] };
  const def = toDefinition(d);
  assert.equal(def.steps[0].checker, "teammate:research");
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
});

test("If / else, For each and Side by side are real branches that store as the engine's own steps", () => {
  const d = { name: "Branches", trigger: { kind: "form", path: "refund" }, steps: [
    { id: "find1", kind: "find", type: "client" },
    { id: "decide2", kind: "decide", cond: { mode: "build", source: "trigger", field: "amount", op: ">", value: "500" },
      then: [{ id: "ask3", kind: "ask", to: "role:attorney", title: "Approve this refund" }],
      else: [{ id: "assign4", kind: "assign", to: "role:attorney", title: "Pay it" }] },
    { id: "repeat5", kind: "repeat", over: "steps.find1.rows", as: "row", steps: [{ id: "email6", kind: "email", to: "a@b.co", subject: "Hi", body: "Hello" }] },
    { id: "parallel7", kind: "parallel", lanes: [{ steps: [{ id: "assign8", kind: "assign", to: "role:attorney", title: "One" }] }, { steps: [{ id: "assign9", kind: "assign", to: "role:attorney", title: "Two" }] }] },
  ] };
  const def = toDefinition(d);
  assert.equal(def.steps[1].if, "trigger.amount > 500");
  assert.equal(def.steps[3].steps[0].kind, "branch");
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.match(stepSummary(d.steps[1], O, d), /^If amount is more than 500: 1 step, otherwise 1$/);
});

test("steps are found, changed, moved and removed at any depth", () => {
  const steps = [{ id: "a", kind: "create" }, { id: "d", kind: "decide", then: [{ id: "t1", kind: "ask", record: "a" }, { id: "t2", kind: "ask" }], else: [] }];
  assert.equal(findStep(steps, "t2").id, "t2");
  assert.deepEqual(flat(steps).map((s) => s.id), ["a", "d", "t1", "t2"]);
  const edited = mapStep(steps, "t1", (s) => ({ ...s, title: "x" }));
  assert.equal(edited[1].then[0].title, "x");
  assert.deepEqual(moveDeep(steps, "t2", -1)[1].then.map((s) => s.id), ["t2", "t1"]);
  assert.deepEqual(canMove(steps, "t1"), { up: false, down: true });
  assert.deepEqual(addTo(steps, { parent: "d", key: "else" }, { id: "e1", kind: "ask" })[1].else.map((s) => s.id), ["e1"]);
  const gone = removeDeep(steps, "a");
  assert.equal(gone[0].id, "d");
  assert.equal(gone[0].then[0].record, "trigger", "what pointed at the removed step points at what started the Flow");
});

test("every other step kind the engine has stores, checks and comes back", () => {
  const d = { name: "Everything", trigger: { kind: "form", path: "intake" }, steps: [
    { id: "find1", kind: "find", type: "client", where: "record.email == trigger.email", limit: 5 },
    { id: "upsert2", kind: "upsert", type: "client", matchFields: [{ field: "Email", value: "{email}" }], fields: [{ field: "Name", value: "{name}" }] },
    { id: "stage3", kind: "stage", type: "client", record: "upsert2", to: "Active" },
    { id: "remove4", kind: "remove", type: "client", record: "upsert2" },
    { id: "wait5", kind: "wait", amount: 2, unit: "days" },
    { id: "formula6", kind: "formula", formula: "round(trigger.amount * 1.2)" },
    { id: "sms7", kind: "sms", to: "{phone}", body: "Hello" },
    { id: "classify8", kind: "classify", input: "{message}", labels: "Urgent, Routine" },
    { id: "extract9", kind: "extract", input: "{message}", fields: [{ name: "Amount", kind: "number" }] },
    { id: "subflow10", kind: "subflow", flow: "send_welcome", fields: [{ field: "Client", value: "{name}" }] },
  ] };
  const def = toDefinition(d);
  assert.equal(def.steps[4].for_ms, 2 * 86_400_000);
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.equal(flat(fromDefinition(def).steps).some((s) => s.kind === "advanced"), false);
});

test("the formula step is a Code step with a fixed source whose hash is the engine's", () => {
  assert.equal(FORMULA_HASH, sourceHash(FORMULA_SOURCE));
});
