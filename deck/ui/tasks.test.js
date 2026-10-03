// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { STATES, TRANSITIONS, canMove, needsReason, needsYou, hasOutput, isComplete, missingOutput, move, approve, makeStuck, unstick, reassign, unblock, stageDone,
  advanceStage, spawnStage, howSentence, cardTitle, whyNot, isGate, startState } from "./tasks.js";

/** @type {any[]} */
const actors = [
  { id: "alex", kind: "person", name: "Alex Rivera" }, { id: "chris", kind: "person", name: "Chris Park" },
  { id: "juno", kind: "assistant", name: "juno", owner: "alex" }, { id: "research", kind: "teammate", name: "Research", owner: "alex" },
  { id: "intake", kind: "teammate", name: "Intake", owner: "alex" },
];
/** @param {Partial<any>} o */
const task = o => ({ id: "k1", title: "T", record: "m1", doer: "juno", checker: null, helpers: [], output: { kind: "file" }, state: "ready", stuck: null, ...o });
const rec = (/** @type {any} */ values) => ({ id: "m1", type: "matter", space: "harlow", values, createdAt: 0, updatedAt: 0 });

test("tasks: the seven states and the allowed moves", () => {
  assert.deepEqual(STATES, ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"]);
  for (const s of STATES) assert.ok(TRANSITIONS[s]);
  assert.equal(canMove("waiting", "ready"), true);
  assert.equal(canMove("working", "needs_check"), true);
  assert.equal(canMove("done", "working"), false, "a finished task does not move again");
  assert.equal(canMove("skipped", "ready"), false);
  assert.equal(canMove("waiting", "done"), false, "a waiting task has to start first");
  assert.throws(() => move(task({ state: "done" }), "working"), /cannot become/);
});

test("needsYou: I check it, I do it, or it is stuck and mine", () => {
  assert.equal(needsReason(task({ checker: "alex", state: "needs_check" }), "alex", actors), "check");
  assert.equal(needsReason(task({ checker: "alex", state: "working" }), "alex", actors), null, "the checker is not asked before the draft is ready");
  assert.equal(needsReason(task({ doer: "alex", state: "ready" }), "alex", actors), "do");
  assert.equal(needsReason(task({ doer: "alex", state: "waiting" }), "alex", actors), null);
  assert.equal(needsReason(task({ doer: "juno", state: "ready" }), "alex", actors), null, "an assistant's ready task is the assistant's");
  assert.equal(needsReason(task({ doer: "juno", state: "stuck", stuck: { reason: "x", since: 0, suggestedFix: "y" } }), "alex", actors), "stuck", "juno is alex's");
  assert.equal(needsReason(task({ doer: "juno", state: "stuck" }), "chris", actors), null, "not chris's assistant");
  assert.equal(needsYou(task({ doer: "alex", state: "done" }), "alex", actors), false);
  assert.equal(needsYou(task({ checker: "chris", state: "needs_check" }), "alex", actors), false);
});

test("output: each kind says when it is done, and an assistant cannot mark Research done with empty fields", () => {
  const research = task({ doer: "research", state: "working", output: { kind: "fields", fields: ["situation", "assets"] } });
  assert.equal(isComplete(research, rec({ situation: "Widowed" })), false);
  assert.match(String(missingOutput(research, rec({ situation: "Widowed" }))), /assets/);
  assert.equal(isComplete(research, rec({ situation: "Widowed", assets: "House" })), true);
  assert.equal(isComplete(research, rec({ situation: "", assets: "  " })), false);
  assert.match(String(whyNot(research, "done", { by: "research", record: rec({}), actors })), /empty/);
  assert.equal(whyNot(research, "done", { by: "research", record: rec({ situation: "a", assets: "b" }), actors }), null);
  assert.equal(isComplete(task({ output: { kind: "note" } }), null), false);
  assert.equal(isComplete(task({ output: { kind: "note" }, result: { note: { text: "x", sources: [] } } }), null), false, "a note needs sources");
  assert.equal(isComplete(task({ output: { kind: "note" }, result: { note: { text: "x", sources: ["a"] } } }), null), true);
  assert.equal(isComplete(task({ output: { kind: "decision" }, result: { decision: { answer: "yes", reason: "" } } }), null), false, "a decision needs a reason");
  assert.equal(isComplete(task({ output: { kind: "decision" }, result: { decision: { answer: "no", reason: "Too high" } } }), null), true);
  assert.equal(isComplete(task({ output: { kind: "file" }, result: { file: { name: "deed.pdf" } } }), null), true);
  assert.equal(isComplete(task({ output: { kind: "draft" }, result: { draft: { body: "Hi" } } }), null), true);
});

test("a sent item is complete only once it left through the checker's approval", () => {
  const t = task({ doer: "intake", checker: "alex", state: "needs_check", output: { kind: "sent", target: "Email" }, result: { draft: { body: "Hi Jane" } } });
  assert.equal(hasOutput(t, null), true);
  assert.equal(isComplete(t, null), false);
  assert.equal(isGate(t), true);
  assert.match(String(whyNot(t, "done", { by: "alex", actors })), /approval/, "no plain Mark done: one card, the approval is the gate");
  assert.throws(() => approve(t, { method: "face_id" }, { by: "chris", now: 5 }), /Only the checker/);
  assert.throws(() => approve(t, /** @type {any} */ ({ method: "sms" }), { by: "alex", now: 5 }), /Face ID/);
  const done = approve(t, { method: "face_id" }, { by: "alex", now: 5 });
  assert.equal(done.state, "done");
  assert.deepEqual(done.result?.sent, { at: 5, by: "alex", method: "face_id" });
  assert.equal(isComplete(done, null), true);
  assert.throws(() => approve(task({ state: "working", checker: "alex", output: { kind: "sent" } }), { method: "face_id" }, { by: "alex", now: 1 }), /Nothing is waiting/);
  assert.throws(() => approve(task({ state: "needs_check", checker: "alex", output: { kind: "sent" } }), { method: "face_id" }, { by: "alex", now: 1 }), /no draft/);
});

test("needs_check needs a checker and a draft; done by a checked task needs the checker", () => {
  const t = task({ doer: "juno", checker: "alex", state: "working", output: { kind: "file" } });
  assert.match(String(whyNot(t, "needs_check", { by: "juno", record: null, actors })), /file/i);
  assert.match(String(whyNot(task({ state: "working" }), "needs_check", {})), /no checker/);
  const withFile = { ...t, result: { file: { name: "a.pdf" } } };
  assert.equal(whyNot(withFile, "needs_check", { by: "juno", actors }), null);
  assert.match(String(whyNot(withFile, "done", { by: "juno", actors })), /checker has to check/);
  assert.equal(whyNot({ ...withFile, state: "needs_check" }, "done", { by: "alex", actors }), null);
  assert.match(String(whyNot({ ...withFile, state: "needs_check" }, "done", { by: "juno", actors })), /Only the checker/);
});

test("a person marks their own unchecked decision done by hand; fields still need values", () => {
  const d = task({ doer: "alex", output: { kind: "decision" } });
  assert.equal(whyNot(d, "done", { by: "alex", actors }), null);
  assert.match(String(whyNot(task({ doer: "juno", output: { kind: "decision" } }), "done", { by: "juno", actors })), /yes or no/);
  assert.match(String(whyNot(task({ doer: "alex", output: { kind: "fields", fields: ["signing"] } }), "done", { by: "alex", record: rec({}), actors })), /empty/);
});

test("stuck: a reason and a suggested fix, then it lands with the owner, and fixing resumes it", () => {
  assert.throws(() => makeStuck(task({ state: "working" }), "  ", "x", 1), /reason/);
  assert.throws(() => makeStuck(task({ state: "done" }), "no", "x", 1), /cannot become stuck/);
  const s = makeStuck(task({ state: "working", doer: "juno" }), "The password changed.", "Update the password in the Vault, or reassign to Chris.", 9);
  assert.deepEqual([s.state, s.stuck?.reason, s.stuck?.suggestedFix, s.stuck?.since], ["stuck", "The password changed.", "Update the password in the Vault, or reassign to Chris.", 9]);
  assert.equal(needsYou(s, "alex", actors), true);
  assert.equal(needsYou(s, "chris", actors), false);
  const back = unstick(s, actors);
  assert.deepEqual([back.state, back.stuck], ["working", null], "an assistant starts again");
  const r = reassign(s, "chris", actors);
  assert.deepEqual([r.doer, r.state, r.stuck], ["chris", "ready", null], "a person gets it ready");
  assert.equal(needsYou(r, "chris", actors), true);
  assert.throws(() => reassign(task({ state: "done" }), "chris", actors), /finished/);
});

test("dependencies: a waiting task starts when what it depends on is done, ready for a person and working for an assistant", () => {
  const a = task({ id: "a", state: "working", doer: "research" });
  const b = task({ id: "b", state: "waiting", doer: "alex", dependsOn: ["a"] });
  const c = task({ id: "c", state: "waiting", doer: "intake", dependsOn: ["a"] });
  const d = task({ id: "d", state: "waiting", doer: "alex", dependsOn: ["b"] });
  assert.deepEqual(unblock([a, b, c, d], actors).started, []);
  const step = unblock([{ ...a, state: "done" }, b, c, d], actors);
  assert.deepEqual(step.started.sort(), ["b", "c"]);
  assert.deepEqual(step.tasks.map(t => t.state), ["done", "ready", "working", "waiting"]);
  assert.equal(startState(b, actors), "ready");
  assert.equal(unblock([{ ...a, state: "skipped" }, b], actors).started[0], "b", "skipped counts as finished");
});

test("stages: done when the required tasks are done, then the record moves on by itself", () => {
  const stages = ["Intake", "Engagement", "Closed"];
  /** @param {string} id @param {string} state @param {Partial<any>} [o] */
  const t = (id, state, o = {}) => task({ id, state, stage: "Intake", ...o });
  assert.equal(stageDone([], "Intake"), false, "a stage with no tasks is not done");
  assert.equal(stageDone([t("a", "done"), t("b", "working")], "Intake"), false);
  assert.equal(stageDone([t("a", "done"), t("b", "done")], "Intake"), true);
  assert.equal(stageDone([t("a", "done"), t("b", "working", { required: false })], "Intake"), true, "an optional task does not hold the stage");
  assert.equal(stageDone([t("a", "done"), t("b", "skipped")], "Intake"), true);
  assert.deepEqual(advanceStage(stages, "Intake", [t("a", "working")]), { moved: false, stage: "Intake" });
  assert.deepEqual(advanceStage(stages, "Intake", [t("a", "done")]), { moved: true, stage: "Engagement", from: "Intake" });
  assert.deepEqual(advanceStage(stages, "Closed", [t("a", "done", { stage: "Closed" })]), { moved: false, stage: "Closed" }, "the last stage stays");
  assert.deepEqual(advanceStage(stages, undefined, []), { moved: false, stage: undefined });
});

test("spawnStage: templates become tasks with dependencies by title, and ones without dependencies start", () => {
  let n = 0;
  const made = spawnStage([
    { title: "Research the client", doer: "research", output: { kind: "fields", fields: ["situation"] }, how: "assistant" },
    { title: "Welcome email for {client}", doer: "intake", checker: "alex", output: { kind: "sent", target: "Email to {client}" }, how: "tailor", template: "tpl1", dependsOn: ["Research the client"], dueInDays: 1 },
    { title: "Optional call", doer: "alex", output: { kind: "decision" }, required: false },
  ], { record: "m1", stage: "Intake", vars: { client: "Jane Doe" }, now: 1000, madeBy: "vyre", newId: () => `k${++n}`, actors });
  assert.deepEqual(made.map(m => [m.id, m.title, m.state]), [["k1", "Research the client", "working"], ["k2", "Welcome email for Jane Doe", "waiting"], ["k3", "Optional call", "ready"]]);
  assert.deepEqual(made[1].dependsOn, ["k1"]);
  assert.equal(made[1].output.target, "Email to Jane Doe");
  assert.equal(made[1].due, 1000 + 86_400_000);
  assert.equal(made[2].required, false);
  const again = spawnStage([{ title: "Research the client", doer: "research", output: { kind: "fields" } }], { record: "m1", stage: "Intake", now: 0, newId: () => "x", actors, existing: made });
  assert.equal(again.length, 0, "entering a stage twice does not make its tasks twice");
});

test("copy: the sentence under a draft, and the card title", () => {
  const t = task({ doer: "intake", how: "tailor", checker: "alex", state: "needs_check", title: "Welcome email for Jane Doe" });
  assert.equal(howSentence(t, { actors, templateName: "Welcome", usedNotesOf: "Research" }), "Intake drafted it from Welcome, using Research's notes.");
  assert.equal(howSentence({ ...t, how: "template" }, { actors, templateName: "Welcome" }), "Intake filled Welcome.");
  assert.equal(howSentence({ ...t, how: "assistant" }, { actors }), "Intake wrote it.");
  assert.equal(cardTitle(t, "check", actors), "Welcome email for Jane Doe is ready");
  assert.equal(cardTitle({ ...t, title: "Q3 report", say: "Email to Dana is waiting for approval" }, "check", actors), "Email to Dana is waiting for approval");
  assert.equal(cardTitle(task({ title: "Review the draft with Jane Doe", doer: "alex" }), "do", actors), "Review the draft with Jane Doe");
  assert.equal(cardTitle(task({ title: "Check the docket", doer: "juno" }), "stuck", actors), "juno could not continue: Check the docket");
});
