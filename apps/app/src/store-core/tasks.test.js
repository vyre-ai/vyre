// @ts-check
// The task model (store-core/tasks.js) over the kernel's Task: who may move a task is the kernel's TASK_TRANSITIONS table, so these tests read the table and the `by` column
// through whyNot(), not a table of their own.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { TASK_TRANSITIONS } from "../../../../kernel/contracts/index.js";
import { STATES, canMove, needsReason, needsYou, hasOutput, isComplete, missingOutput, move, approve, reject, makeStuck, reassign, unblock, stageDone, stageProgress,
  advanceStage, spawnStage, howSentence, cardTitle, whyNot, isGate, startsItself, withEvidence, handEvidence, offers } from "./tasks.js";
import { simulatedProof } from "./kernel-view.js";

const SPACE = "spc_juniperaaaaaa";
/** The directory the Deck holds: people, assistants and teammates, with whose they are. @type {any[]} */
const actors = [
  { id: "alex", family: "person", name: "Alex Rivera" }, { id: "chris", family: "person", name: "Chris Park" },
  { id: "juno", family: "assistant", name: "juno", owner: "alex" }, { id: "research", family: "teammate", name: "Research", owner: "alex" },
  { id: "intake", family: "teammate", name: "Intake", owner: "alex" },
];
/** The kernel's Actor for a directory id. @param {string} id */
const A = id => ({ kind: actors.find(a => a.id === id)?.family === "person" ? "person" : "agent", id, space: SPACE });
/** A kernel task; `doer` and `checker` are directory ids here and become Actors. @param {Partial<any>} o */
const task = ({ doer = "juno", checker = null, ...o } = {}) => /** @type {any} */ ({ id: "k1", space: SPACE, title: "T", record: `vyre://${SPACE}/matter/m1`, doer: A(doer), ...(checker ? { checker: A(checker) } : {}),
  output: { kind: "file" }, state: "ready", depends_on: [], assigned_by: A("alex"), labels: {}, created_at: 0, updated_at: 0, ...o });
const rec = (/** @type {any} */ data) => /** @type {any} */ ({ type: "matter", id: "m1", urn: `vyre://${SPACE}/matter/m1`, version: 1, data, created_at: 0, updated_at: 0, labels: {} });
const proof = (/** @type {string} */ decision) => simulatedProof({ decision, now: 5 });
const withResult = (/** @type {any} */ t, /** @type {any} */ result) => ({ ...t, ext: { ...(t.ext || {}), result } });

test("tasks: the seven states, and the moves are the kernel's table", () => {
  assert.deepEqual(STATES, ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"]);
  for (const s of STATES) assert.ok(TASK_TRANSITIONS.some(r => r.from === s || r.to === s), `${s} is in the table`);
  for (const r of TASK_TRANSITIONS) assert.equal(canMove(r.from, r.to), true, `${r.from} to ${r.to}`);
  assert.equal(canMove("waiting", "ready"), true);
  assert.equal(canMove("working", "needs_check"), true);
  assert.equal(canMove("done", "working"), false, "a finished task does not move again");
  assert.equal(canMove("skipped", "ready"), false);
  assert.equal(canMove("waiting", "done"), false, "a waiting task has to start first");
  assert.equal(canMove("stuck", "working"), false, "a stuck task goes back to ready, and its doer starts it from there");
  assert.throws(() => move(task({ state: "done" }), "working"), /cannot become/);
});

test("tasks: the table's `by` column decides who may move a task", () => {
  // waiting -> ready is the kernel's, when dependencies are met.
  assert.match(String(whyNot(task({ state: "waiting" }), "ready", { by: "alex", actors })), /starts by itself/);
  assert.equal(whyNot(task({ state: "waiting" }), "ready", { kernel: true, actors }), null);
  // ready -> working is the doer's.
  assert.equal(whyNot(task({ state: "ready", doer: "juno" }), "working", { by: "juno", actors }), null);
  assert.match(String(whyNot(task({ state: "ready", doer: "juno" }), "working", { by: "alex", actors })), /Only the doer/);
  // working -> stuck is the assistant itself or the kernel's detection, never a person.
  assert.equal(whyNot(task({ state: "working", doer: "juno" }), "stuck", { by: "juno", actors }), null);
  assert.equal(whyNot(task({ state: "working", doer: "juno" }), "stuck", { detected: true, actors }), null);
  assert.match(String(whyNot(task({ state: "working", doer: "juno" }), "stuck", { by: "alex", actors })), /Only the assistant itself, or Vyre/);
  // needs_check -> ready (send it back) is the checker's, a person.
  assert.equal(whyNot(task({ state: "needs_check", checker: "alex", doer: "juno" }), "ready", { by: "alex", actors }), null);
  assert.match(String(whyNot(task({ state: "needs_check", checker: "alex", doer: "juno" }), "ready", { by: "juno", actors })), /Only the checker/);
  // What a person is offered is exactly what the table lets them do.
  assert.deepEqual(offers(task({ state: "needs_check", checker: "alex", doer: "juno" }), { by: "chris", actors }), []);
  assert.ok(offers(task({ state: "needs_check", checker: "alex", doer: "juno" }), { by: "alex", actors, presence: true }).includes("done"));
});

test("needsYou: I check it, I do it, or it is stuck and mine", () => {
  assert.equal(needsReason(task({ checker: "alex", state: "needs_check" }), "alex", actors), "check");
  assert.equal(needsReason(task({ checker: "alex", state: "working" }), "alex", actors), null, "the checker is not asked before the draft is ready");
  assert.equal(needsReason(task({ doer: "alex", state: "ready" }), "alex", actors), "do");
  assert.equal(needsReason(task({ doer: "alex", state: "waiting" }), "alex", actors), null);
  assert.equal(needsReason(task({ doer: "juno", state: "ready" }), "alex", actors), null, "an assistant's ready task is the assistant's");
  assert.equal(needsReason(task({ doer: "juno", state: "stuck", stuck: { reason: "x", since: 0 } }), "alex", actors), "stuck", "juno is alex's");
  assert.equal(needsReason(task({ doer: "juno", state: "stuck" }), "chris", actors), null, "not chris's assistant");
  assert.equal(needsYou(task({ doer: "alex", state: "done" }), "alex", actors), false);
  assert.equal(needsYou(task({ checker: "chris", state: "needs_check" }), "alex", actors), false);
});

test("output: each kind says when it is done, and an assistant cannot mark Research done with empty fields", () => {
  const research = task({ doer: "research", state: "working", output: { kind: "fields", target: "situation, assets" } });
  assert.equal(isComplete(research, rec({ situation: "Widowed" })), false);
  assert.match(String(missingOutput(research, rec({ situation: "Widowed" }))), /assets/);
  assert.equal(isComplete(research, rec({ situation: "Widowed", assets: "House" })), true);
  assert.equal(isComplete(research, rec({ situation: "", assets: "  " })), false);
  // The kernel's output check runs when Vyre moves the task: empty fields are refused, filled ones pass.
  assert.match(String(whyNot(research, "done", { kernel: true, record: rec({}), actors })), /empty/);
  assert.equal(whyNot(research, "done", { kernel: true, record: rec({ situation: "a", assets: "b" }), actors }), null);
  // And only Vyre moves it: the assistant has no move to done of its own.
  assert.match(String(whyNot(research, "done", { by: "research", record: rec({ situation: "a", assets: "b" }), actors })), /Vyre moves this once the output is checked/);
  assert.equal(isComplete(task({ output: { kind: "note" } }), null), false);
  assert.equal(isComplete(withResult(task({ output: { kind: "note" } }), { note: { text: "x", sources: [] } }), null), false, "a note needs sources");
  assert.equal(isComplete(withResult(task({ output: { kind: "note" } }), { note: { text: "x", sources: ["a"] } }), null), true);
  assert.equal(isComplete(task({ output: { kind: "decision" }, answer: { answer: "yes", reason: "" } }), null), false, "a decision needs a reason");
  assert.equal(isComplete(task({ output: { kind: "decision" }, answer: { answer: "no", reason: "Too high" } }), null), true);
  assert.equal(isComplete(withResult(task({ output: { kind: "file" } }), { file: { name: "deed.pdf" } }), null), true);
  assert.equal(isComplete(withResult(task({ output: { kind: "draft" } }), { draft: { body: "Hi" } }), null), true);
});

test("a sent item is complete only once it left through the checker's approval", () => {
  const t = withResult(task({ doer: "intake", checker: "alex", state: "needs_check", output: { kind: "sent", target: "Email" } }), { draft: { body: "Hi Jane" } });
  assert.equal(hasOutput(t, null), true);
  assert.equal(isComplete(t, null), false);
  assert.equal(isGate(t), true);
  assert.match(String(whyNot(t, "done", { by: "alex", actors })), /approval/, "no plain Mark done: one card, the approval is the gate");
  assert.throws(() => approve(t, proof("approve"), { by: "chris", now: 5, actors }), /Only the checker/);
  assert.throws(() => approve(t, /** @type {any} */ ({ signer: "sms" }), { by: "alex", now: 5, actors }), /Face ID/);
  const done = approve(t, proof("approve"), { by: "alex", now: 5, actors });
  assert.equal(done.state, "done");
  assert.equal(done.outcome, "approved");
  assert.deepEqual(done.payload, { payload_hash: "preview", decision: "approve" });
  assert.equal(isComplete(done, null), true);
  assert.throws(() => approve(task({ state: "working", checker: "alex", output: { kind: "sent" } }), proof("approve"), { by: "alex", now: 1, actors }), /Nothing is waiting/);
  assert.throws(() => approve(task({ state: "needs_check", checker: "alex", output: { kind: "sent" } }), proof("approve"), { by: "alex", now: 1, actors }), /no draft/);
});

test("a checker sends a draft back with a reason, with a presence proof, and only the checker can", () => {
  const t = withResult(task({ doer: "intake", checker: "alex", state: "needs_check", output: { kind: "sent" } }), { draft: { body: "Hi" } });
  const back = reject(t, "Shorter", proof("reject"), { by: "alex", now: 6, actors });
  assert.deepEqual([back.state, back.outcome, back.answer], ["ready", "rejected", { reason: "Shorter" }]);
  assert.throws(() => reject(t, "x", proof("reject"), { by: "intake", now: 6, actors }), /Only the checker/);
  assert.throws(() => reject(t, "x", /** @type {any} */ ({ signer: "none" }), { by: "alex", now: 6, actors }), /presence proof/);
  assert.throws(() => reject(task({ state: "working" }), "x", proof("reject"), { by: "alex", now: 6, actors }), /Nothing is waiting/);
});

test("needs_check needs a checker and an output; done by a checked task needs the checker's approval", () => {
  const t = task({ doer: "juno", checker: "alex", state: "working", output: { kind: "file" } });
  assert.match(String(whyNot(t, "needs_check", { kernel: true, record: null, actors })), /file/i);
  assert.match(String(whyNot(task({ state: "working" }), "needs_check", { kernel: true, actors })), /cannot become/, "no checker, no check: the table has no such move for this task");
  const withFile = withResult(t, { file: { name: "a.pdf" } });
  assert.equal(whyNot(withFile, "needs_check", { kernel: true, actors }), null);
  assert.match(String(whyNot(withFile, "done", { kernel: true, actors })), /cannot become/, "a checked task does not go straight to done");
  const waiting = { ...withFile, state: "needs_check" };
  assert.match(String(whyNot(waiting, "done", { by: "alex", actors })), /approval/, "the checker's approval needs a proof");
  assert.equal(whyNot(waiting, "done", { by: "alex", actors, proof: proof("approve") }), null);
  assert.match(String(whyNot(waiting, "done", { by: "juno", actors, proof: proof("approve") })), /Only the checker/);
});

test("a person's own unchecked decision is done once there is a yes or no with a reason; fields still need values", () => {
  const d = task({ doer: "alex", state: "working", output: { kind: "decision" } });
  assert.match(String(whyNot(d, "done", { kernel: true, record: null, actors })), /yes or no/);
  assert.deepEqual(handEvidence(d), { decision: { answer: "yes", reason: "Done by hand." } });
  const answered = withEvidence(d, handEvidence(d));
  assert.deepEqual(answered.answer, { answer: "yes", reason: "Done by hand." });
  assert.equal(whyNot(answered, "done", { kernel: true, record: null, actors }), null);
  assert.match(String(whyNot(task({ doer: "alex", state: "working", output: { kind: "fields", target: "signing" } }), "done", { kernel: true, record: rec({}), actors })), /empty/);
  assert.equal(whyNot(task({ doer: "alex", state: "working", output: { kind: "fields", target: "signing" } }), "done", { kernel: true, record: rec({ signing: "2026-10-20" }), actors }), null);
});

test("stuck: a reason and a suggested fix, it lands with the owner, and reassigning resumes it", () => {
  assert.throws(() => makeStuck(task({ state: "working" }), "  ", "x", 1), /reason/);
  assert.throws(() => makeStuck(task({ state: "done" }), "no", "x", 1), /cannot become stuck/);
  assert.throws(() => makeStuck(task({ state: "working", doer: "alex" }), "no", "x", 1, { by: "alex", actors }), /Only the assistant itself, or Vyre/, "a person does not mark their own task stuck");
  const s = makeStuck(task({ state: "working", doer: "juno" }), "The password changed.", "Update the password in the Vault, or reassign to Chris.", 9);
  assert.deepEqual([s.state, s.stuck?.reason, s.stuck?.suggested_fix?.text, s.stuck?.since], ["stuck", "The password changed.", "Update the password in the Vault, or reassign to Chris.", 9]);
  assert.equal(needsYou(s, "alex", actors), true);
  assert.equal(needsYou(s, "chris", actors), false);
  // Back to ready under the person responsible for the doer: to the same doer once it is fixed, or to another.
  const same = reassign(s, A("juno"), { by: "alex", actors });
  assert.deepEqual([same.state, same.stuck, same.doer.id], ["ready", undefined, "juno"]);
  const r = reassign(s, A("chris"), { by: "alex", actors });
  assert.deepEqual([r.doer.id, r.state, r.stuck], ["chris", "ready", undefined], "a person gets it ready");
  assert.equal(needsYou(r, "chris", actors), true);
  // Not the stuck assistant itself, and not another person without presence.
  assert.match(String(whyNot(s, "ready", { by: "juno", actors })), /Only the person responsible/);
  assert.throws(() => reassign(s, A("chris"), { by: "chris", actors }), /Only the person responsible/);
  assert.equal(reassign(s, A("chris"), { by: "chris", actors, presence: true }).state, "ready", "another person may, with a fresh presence proof");
  assert.throws(() => reassign(task({ state: "done" }), A("chris"), { by: "alex", actors }), /finished/);
});

test("dependencies: a waiting task becomes ready when what it depends on is done, and an assistant's ready task then starts itself", () => {
  const a = task({ id: "a", state: "working", doer: "research" });
  const b = task({ id: "b", state: "waiting", doer: "alex", depends_on: ["a"] });
  const c = task({ id: "c", state: "waiting", doer: "intake", depends_on: ["a"] });
  const d = task({ id: "d", state: "waiting", doer: "alex", depends_on: ["b"] });
  assert.deepEqual(unblock([a, b, c, d]).started, []);
  const step = unblock([{ ...a, state: "done" }, b, c, d]);
  assert.deepEqual(step.started.sort(), ["b", "c"]);
  assert.deepEqual(step.tasks.map(t => t.state), ["done", "ready", "ready", "waiting"], "the kernel makes them ready; starting is the doer's own move");
  assert.equal(startsItself(step.tasks[1], actors), false, "a person's task waits for the person");
  assert.equal(startsItself(step.tasks[2], actors), true, "a teammate's task starts by itself");
  assert.equal(unblock([{ ...a, state: "skipped" }, b]).started[0], "b", "skipped counts as finished");
});

test("stages: done when the required tasks are done, then the record moves on by itself", () => {
  const stages = ["Intake", "Engagement", "Closed"];
  /** @param {string} id @param {string} state @param {Partial<any>} [o] */
  const t = (id, state, o = {}) => task({ id, state, stage: "Intake", ...o });
  const optional = { ext: { required: false } };
  assert.equal(stageDone([], "Intake"), false, "a stage with no tasks is not done");
  assert.equal(stageDone([t("a", "done"), t("b", "working")], "Intake"), false);
  assert.equal(stageDone([t("a", "done"), t("b", "done")], "Intake"), true);
  assert.equal(stageDone([t("a", "done"), t("b", "working", optional)], "Intake"), true, "an optional task does not hold the stage");
  assert.equal(stageDone([t("a", "done"), t("b", "skipped")], "Intake"), true);
  assert.deepEqual(stageProgress([t("a", "done"), t("b", "working"), t("c", "working", optional)], "Intake"), { done: 1, total: 2 });
  assert.deepEqual(advanceStage(stages, "Intake", [t("a", "working")]), { moved: false, stage: "Intake" });
  assert.deepEqual(advanceStage(stages, "Intake", [t("a", "done")]), { moved: true, stage: "Engagement", from: "Intake" });
  assert.deepEqual(advanceStage(stages, "Closed", [t("a", "done", { stage: "Closed" })]), { moved: false, stage: "Closed" }, "the last stage stays");
  assert.deepEqual(advanceStage(stages, undefined, []), { moved: false, stage: undefined });
});

test("spawnStage: templates become tasks with dependencies by title, and ones without dependencies are ready", () => {
  let n = 0;
  const templates = /** @type {any[]} */ ([
    { title: "Research the client", doer: "teammate:research", output: { kind: "fields", target: "situation" }, how: "assistant" },
    { title: "Welcome email for {client}", doer: "teammate:intake", checker: "person:alex", output: { kind: "sent", target: "Email to {client}" }, how: "tailor", template: "Welcome", depends_on: ["Research the client"], due_offset_ms: 86_400_000 },
    { title: "Optional call", doer: "person:alex", output: { kind: "decision" }, required: false },
  ]);
  const ctx = { record: `vyre://${SPACE}/matter/m1`, space: SPACE, stage: "Intake", vars: { client: "Jane Doe" }, now: 1000, assignedBy: A("alex"), newId: () => `k${++n}`,
    actor: (/** @type {string} */ r) => A(r.split(":")[1]), templateUrn: (/** @type {string} */ name) => `vyre://${SPACE}/template/${name}` };
  const made = spawnStage(templates, ctx);
  assert.deepEqual(made.map(m => [m.id, m.title, m.state]), [["k1", "Research the client", "ready"], ["k2", "Welcome email for Jane Doe", "waiting"], ["k3", "Optional call", "ready"]]);
  assert.deepEqual(made[1].depends_on, ["k1"]);
  assert.deepEqual(made[0].output, { kind: "fields", target: ["situation"] });
  assert.equal(made[1].output.target, "Email to Jane Doe");
  assert.equal(made[1].checker?.id, "alex");
  assert.equal(made[1].template, `vyre://${SPACE}/template/Welcome`);
  assert.equal(made[1].due, 1000 + 86_400_000);
  assert.equal(made[2].ext?.required, false);
  const again = spawnStage([templates[0]], { ...ctx, now: 0, existing: made });
  assert.equal(again.length, 0, "entering a stage twice does not make its tasks twice");
});

test("copy: the sentence under a draft, and the card title", () => {
  const t = task({ doer: "intake", how: "tailor", checker: "alex", state: "needs_check", title: "Welcome email for Jane Doe" });
  assert.equal(howSentence(t, { actors, templateName: "Welcome", usedNotesOf: "Research" }), "Intake drafted it from Welcome, using Research's notes.");
  assert.equal(howSentence({ ...t, how: "template" }, { actors, templateName: "Welcome" }), "Intake filled Welcome.");
  assert.equal(howSentence({ ...t, how: "assistant" }, { actors }), "Intake wrote it.");
  assert.equal(cardTitle(t, "check", actors), "Welcome email for Jane Doe is ready");
  assert.equal(cardTitle({ ...t, title: "Q3 report", ext: { say: "Email to Dana is waiting for approval" } }, "check", actors), "Email to Dana is waiting for approval");
  assert.equal(cardTitle(task({ title: "Review the draft with Jane Doe", doer: "alex" }), "do", actors), "Review the draft with Jane Doe");
  assert.equal(cardTitle(task({ title: "Check the docket", doer: "juno" }), "stuck", actors), "juno could not continue: Check the docket");
});
