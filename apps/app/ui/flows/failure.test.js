import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { world, install, settle } from "../../../../kernel/flows/testing/world.js";
import { findStep, flat, mapStep, removeDeep, lanesOf, laneSteps } from "./tree.js";
import * as logic from "./logic.js";
import { draftProblems, fromDefinition, newStep, stepProblem, toDefinition, valueSources, val, policyWords } from "./logic.js";
import { offers, policyKeys, span } from "./failure.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const flowOf = (steps, extra = {}) => ({ format: 1, name: "refunds", label: "Refunds", authorship: "builder", trigger: { on: "manual" }, steps, ...extra });
const make = (id, extra = {}) => ({ id, kind: "create", type: "matter", set: { client: "X" }, ...extra });
const note = (id, text) => make(id, { set: { client: { expr: text } } });

// What a person sets in the failure panel is stored on the step under the engine's own keys.
const FULL = flowOf([
  make("m1", { timeout_ms: 30_000, retry: { attempts: 4, backoff_ms: 5000, on: ["timeout", "busy"] }, verify: { readback: true, essential: false, say: "The record did not save as written." }, on_fail: { then: "continue", steps: [note("tell1", "error.message")] } }),
  { id: "d1", kind: "decide", if: "trigger.amount > 5", then: [make("m2", { retry: false })], else: [], on_fail: { steps: [note("tell2", "error.code")] } },
  make("m3"),
], { on_failure: [note("alert1", "error.step")] });

test("a stored Flow with failure settings opens as editable steps, and saves back unchanged", () => {
  assert.deepEqual(checkFlow(FULL), []);
  const d = fromDefinition(FULL);
  assert.deepEqual(d.steps.map((s) => s.kind), ["create", "decide", "create"], "no step fell back to Advanced (before, a step with retry or on_fail did)");
  assert.equal(d.steps[0].retry.attempts, 4);
  assert.deepEqual(d.steps[0].on_fail.steps[0].fields, [{ field: "client", value: "{error.message}" }], "a handler reads what went wrong as a plain token");
  assert.equal(d.onFailure.length, 1);
  assert.equal(d.rest, undefined, "the Flow's own failure steps are not hidden in the leftovers");
  assert.deepEqual(toDefinition(d), FULL);
});

test("a failure setting the panel cannot show keeps its step whole instead of dropping it", () => {
  const odd = flowOf([make("m1", { verify: { check: "output.ok", surprise: true } })]);
  const d = fromDefinition(odd);
  assert.equal(d.steps[0].kind, "advanced");
  assert.deepEqual(toDefinition(d), odd);
});

test("every option set on a draft step is stored and passes the engine's own check", () => {
  const d = { name: "Refunds", trigger: { kind: "manual" }, steps: [], onFailure: [] };
  const a = newStep("create", d, O); Object.assign(a, { type: "matter", fields: [{ field: "client", value: "X" }], timeout_ms: 60_000, retry: { attempts: 2, backoff_ms: 1000 }, verify: { check: "output.record.id", essential: true, say: "Nothing was made." }, on_fail: { then: "stop", steps: [] } });
  d.steps.push(a);
  const h = newStep("create", d, O); Object.assign(h, { type: "matter", fields: [{ field: "client", value: "{error.message}" }] });
  a.on_fail.steps.push(h);
  const f = newStep("create", d, O); Object.assign(f, { type: "matter", fields: [{ field: "client", value: "{error.step}" }] });
  d.onFailure.push(f);
  assert.deepEqual(draftProblems(d, O), []);
  const stored = toDefinition(d);
  assert.deepEqual(checkFlow(stored), []);
  assert.deepEqual(stored.steps[0].timeout_ms, 60_000);
  assert.deepEqual(stored.steps[0].on_fail.steps[0].set.client, { expr: "error.message" });
  assert.deepEqual(stored.on_failure[0].set.client, { expr: "error.step" });
  assert.deepEqual(toDefinition(fromDefinition(stored)), stored, "reopen and save changes nothing");
});

test("step ids stay unique across the Flow's failure steps", () => {
  const d = fromDefinition(FULL);
  const ids = flat([...d.steps, ...d.onFailure]).map((s) => s.id);
  const next = newStep("create", d, O);
  assert.ok(!ids.includes(next.id), next.id);
});

test("the failure path of a step is one more lane the tree helpers walk", () => {
  const d = fromDefinition(flowOf([make("m1", { on_fail: { steps: [make("h1")] } })]));
  assert.deepEqual(lanesOf(d.steps[0]).map((l) => l.key), ["on_fail"]);
  assert.deepEqual(flat(d.steps).map((s) => s.id), ["m1", "h1"]);
  assert.equal(findStep(d.steps, "h1").kind, "create");
  const edited = mapStep(d.steps, "h1", (s) => ({ ...s, type: "note" }));
  assert.equal(laneSteps(edited[0], "on_fail")[0].type, "note");
  assert.equal(removeDeep(d.steps, "h1")[0].on_fail.steps.length, 0, "the step goes, its failure path stays");
});

test("a step in a failure path can read what went wrong, and no other step is offered it", () => {
  const d = fromDefinition(flowOf([make("m1", { on_fail: { steps: [make("h1")] } }), make("m2")], { on_failure: [make("alert1")] }));
  const tokens = (id) => valueSources(d, id, O).map(([t]) => t);
  assert.ok(tokens("h1").includes("{error.message}"));
  assert.ok(tokens("alert1").includes("{error.code}"));
  assert.ok(!tokens("m2").includes("{error.message}"));
  assert.equal(logic.inFailurePath(d, "h1"), true);
  assert.equal(logic.inFailurePath(d, "m1"), false);
  assert.deepEqual(val("{error.message}"), { expr: "error.message" });
});

test("what the panel offers follows what the engine does with each kind of step", () => {
  assert.deepEqual(policyKeys("wait"), ["retry", "on_fail", "verify"]);
  assert.deepEqual(policyKeys("decide"), ["on_fail", "verify"]);
  assert.equal(offers("agent").timeout, false, "on a step that waits for an agent it is a due time, not a limit on one try");
  assert.equal(offers("agent").due, true);
  assert.equal(span(86_400_000), "1 day");
  assert.equal(offers("create").timeout, true);
  assert.equal(offers("create").readback, true);
  assert.equal(offers("email").readback, false);
  assert.equal(span(90_000), "90 seconds");
  assert.equal(span(120_000), "2 minutes");
});

test("a half-set panel says what is missing, in words", () => {
  const s = (extra) => ({ id: "m1", kind: "create", type: "matter", fields: [{ field: "client", value: "X" }], ...extra });
  assert.match(stepProblem(s({ on_fail: { steps: [] } }), O), /steps to run if this fails/);
  assert.match(stepProblem(s({ verify: { essential: true } }), O), /how to check the work/);
  assert.match(stepProblem(s({ verify: { check: "1 +" } }), O), /not a formula/);
  assert.equal(stepProblem(s({ verify: { readback: true } }), O), null);
  assert.equal(policyWords({ id: "a", kind: "agent", timeout_ms: 86_400_000 }), ", due in 1 day");
  assert.equal(policyWords(s({ timeout_ms: 60_000, retry: { attempts: 3 }, on_fail: { steps: [{}] } })), ", gives up after 1 minute, tries up to 3 times, 1 step to run if it fails");
});

// The run does what the panel shows: a check that fails sends the step down its failure path, and the Flow goes on.
test("a Flow written by the builder runs its check, its failure path and the Flow's own failure steps", async () => {
  const d = { name: "Refunds", id: "refunds", trigger: { kind: "advanced", raw: { on: "event", event: "payment.received" } }, steps: [], onFailure: [] };
  const check = newStep("formula", d, O);
  Object.assign(check, { formula: "1", retry: false, verify: { check: "output.value > 100", essential: true, say: "too small" }, on_fail: { then: "continue", steps: [] } });
  const tell = newStep("create", d, O); Object.assign(tell, { type: "matter", fields: [{ field: "client", value: "{error.message}" }] });
  check.on_fail.steps.push(tell);
  d.steps.push(check);
  const after = newStep("create", d, O); Object.assign(after, { type: "matter", fields: [{ field: "client", value: "after" }] });
  d.steps.push(after);
  assert.deepEqual(draftProblems(d, O), []);
  const w = await world({ ports: { sandbox: async () => ({ outputs: { value: 5 } }) } });
  await install(w, toDefinition(d));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  const run = (await w.runner.listRuns())[0];
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps[check.id].status, "failed_handled");
  const made = [...(w.kernel.tables.get("matter") || new Map()).values()].map((m) => m.data.client).sort();
  assert.deepEqual(made, ["after", "too small"]);
});
