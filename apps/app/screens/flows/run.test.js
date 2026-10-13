// @ts-check
// A Flow's start, retry and run record against a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: { id: "run_1" } }; };
  return { call, seen };
}

test("Run now is flows.start with the Flow, its input and a key", { skip: !strip }, async () => {
  const { runSource } = await import("./run-source.ts");
  const b = box();
  const r = await runSource(b.call).startReal("welcome", "k1");
  assert.deepEqual(b.seen, [{ tool: "flows.start", input: { id: "welcome", input: {}, key: "k1" } }]);
  assert.equal(r.id, "run_1");
});

test("a Flow that is paused refuses the start, and the person gets plain words", { skip: !strip }, async () => {
  const { runSource } = await import("./run-source.ts");
  const { startRefusal } = await import("./run-model.ts");
  const b = box({ "flows.start": { error: { code: "not_active", message: "that Flow is not running (it is paused, disabled or has no approved version)" } } });
  await assert.rejects(runSource(b.call).startReal("welcome", "k1"), (/** @type {any} */ e) => e.code === "not_active" && /paused or has no approved version/.test(startRefusal(e.code, e.message)));
});

test("Retry is flows.retry on the run, and only a failed or paused run offers it", { skip: !strip }, async () => {
  const { runSource } = await import("./run-source.ts");
  const { canRetry } = await import("./run-model.ts");
  const b = box({ "flows.retry": { data: { ok: true } } });
  await runSource(b.call).retryReal("run_9");
  assert.deepEqual(b.seen, [{ tool: "flows.retry", input: { run: "run_9" } }]);
  assert.deepEqual(["failed", "paused", "done", "running", "waiting"].map(canRetry), [true, true, false, false, false]);
});

test("the run's record says what each step did, in the Flow's order", { skip: !strip }, async () => {
  const { recordLines } = await import("./run-model.ts");
  const lines = recordLines([
    { id: "trigger", label: "A new lead arrives", state: "done" },
    { id: "s1", label: "Ask Kit to draft a reply", state: "waiting", note: "Waiting for a person's yes" },
    { id: "s2", label: "Send the reply", state: "pending" },
    { id: "s3", label: "Log each document", state: "done", count: 3 },
  ]);
  assert.deepEqual(lines.map((l) => [l.title, l.sub]), [["A new lead arrives", "Done"], ["Ask Kit to draft a reply", "Waiting, Waiting for a person's yes"], ["Send the reply", "Not reached"], ["Log each document", "Done, 3 times"]]);
});

const at = (/** @type {number} */ ms) => `t${ms}`;
const painted = [{ id: "trigger", kind: "trigger", label: "A new lead" }, { id: "a", label: "Look up the client" }, { id: "b", label: "Text the client" }, { id: "c", label: "Wait a day" }, { id: "d", label: "Ask the partner" }, { id: "e", label: "File the notes" }];

test("a run reads step by step: name, status, time taken, in the Flow's order, and a step never reached says so", { skip: !strip }, async () => {
  const { stepRows } = await import("./run-model.ts");
  const rows = stepRows(painted, {
    a: { status: "done", started_at: 1000, finished_at: 3500, input: { email: "pat@example.com" }, output: { found: true } },
    b: { status: "started", tries: 1, started_at: 4000 },
  }, at, { b: 3 });
  assert.deepEqual(rows.map((r) => [r.title, r.status, r.tone]), [["Look up the client", "Done", "ok"], ["Text the client", "Retrying, try 2 of 3", "warn"], ["Wait a day", "Not reached", "plain"], ["Ask the partner", "Not reached", "plain"], ["File the notes", "Not reached", "plain"]]);
  assert.equal(rows[0].took, "Took 3 seconds");
  assert.deepEqual(rows[0].inputs, [["email", "pat@example.com"]]);
});

test("a wait says when it wakes, and only a wait for a person is violet", { skip: !strip }, async () => {
  const { stepRows } = await import("./run-model.ts");
  const rows = stepRows(painted, {
    c: { status: "waiting", wait: { kind: "time", until: 9000 } },
    d: { status: "waiting", wait: { kind: "task", task: "tsk_1" } },
  }, at);
  const [c, d] = [rows[2], rows[3]];
  assert.deepEqual([c.status, c.wakes, c.tone], ["Waiting", "Wakes t9000", "plain"]);
  assert.deepEqual([d.status, d.tone], ["Waiting for a person", "accent"]);
  assert.deepEqual(rows.filter((r) => r.tone === "accent").length, 1);
});

test("a failed step gives the error in plain words and what to do next; a skipped step says so", { skip: !strip }, async () => {
  const { stepRows } = await import("./run-model.ts");
  const rows = stepRows(painted, {
    a: { status: "failed", error: { code: "timeout", message: "The lookup did not answer." } },
    b: { status: "skipped", skipped_by: "Pat", substitute: { ok: true } },
    e: { status: "failed", error: { code: "weird" } },
  }, at);
  assert.equal(rows[0].status, "Failed");
  assert.equal(rows[0].error, "The lookup did not answer. Retry the run; if it keeps happening, check the service the step calls.");
  assert.equal(rows[1].status, "Skipped, value given by Pat");
  assert.match(rows[4].error, /Retry the run, or ask whoever set the Flow up/);
});

test("a sealed value is only its placeholder, never the value, in a step's inputs and outputs", { skip: !strip }, async () => {
  const { stepRows, shownValue, SEALED } = await import("./run-model.ts");
  assert.equal(shownValue({ sealed: true }), SEALED);
  assert.equal(shownValue("{{field:ssn}}"), SEALED);
  assert.equal(shownValue("hunter2", "api_key"), "Hidden");
  const rows = stepRows(painted, { a: { status: "done", input: { ssn: "{{field:ssn}}", note: { sealed: "123-45-6789" }, nested: { deep: { sealed: "999" } } }, output: { token: "abc" } } }, at);
  const text = JSON.stringify(rows[0]);
  assert.doesNotMatch(text, /123-45-6789|999|abc/);
  assert.deepEqual(rows[0].inputs.slice(0, 2), [["ssn", SEALED], ["note", SEALED]]);
  assert.deepEqual(rows[0].outputs, [["token", "Hidden"]]);
});

test("a loop's turns and a step's failure path each get their own row; retry limits come from what the Flow states", { skip: !strip }, async () => {
  const { stepRows, retryLimits } = await import("./run-model.ts");
  const rows = stepRows(painted, { "b@0": { status: "done" }, "b@1": { status: "done" }, "b!x": { status: "done" } }, at);
  assert.deepEqual(rows.filter((r) => r.title.startsWith("Text the client")).map((r) => r.title), ["Text the client (turn 1)", "Text the client (turn 2)", "Text the client, failure path"]);
  assert.deepEqual(retryLimits({ steps: [{ id: "a", retry: { attempts: 4 } }, { id: "b", kind: "decide", then: [{ id: "c", retry: { attempts: 2 } }] }, { id: "d" }] }), { a: 4, c: 2 });
});

test("a run's page header says what ran, where it stands, who approved the version, and links the record", { skip: !strip }, async () => {
  const { runHeader } = await import("./run-model.ts");
  const h = runHeader({ state: "done", started_at: 1, finished_at: 5, version: 3 }, { fmt: at, title: "Appointment reminder", number: 4, approver: "Pat", record: "vyre://s/matter/m_9" });
  assert.deepEqual([h.title, h.sub, h.status, h.tone, h.started, h.approver, h.recordId], ["Run of t1", "Appointment reminder, run 4, version 3", "Done", "ok", "Finished t5", "Version approved by Pat", "m_9"]);
  const w = runHeader({ state: "waiting", waiting: { kind: "task" } }, { fmt: at, title: "x", number: null, approver: "" });
  assert.deepEqual([w.status, w.tone, w.approver, w.recordId], ["Waiting for a person", "accent", "", ""]);
});

test("a step shows its tries and who it waits on or who answered", { skip: !strip }, async () => {
  const { stepRows } = await import("./run-model.ts");
  const rows = stepRows(painted, { a: { status: "done", tries: 1, attempts_log: [{ at: 5, code: "timeout" }] }, "d?ask": { status: "waiting", wait: { kind: "task" }, answered: { by: "per_1" } } }, at);
  assert.deepEqual(rows[0].tries, ["Try 1 at t5 did not work (timeout)"]);
  assert.equal(rows[3].by, "per_1");
});
