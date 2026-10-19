import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryFromRefusal, isOutwardStep } from "./real-model.js";

const flow = { steps: [
  { id: "find1", kind: "find", type: "contact" },
  { id: "email2", kind: "call", action: "comms.email", resource: "vyre://space/comms", input: {} },
  { id: "decide3", kind: "decide", if: "true", then: [{ id: "tag4", kind: "update", type: "contact", record: { expr: "x" }, set: {} }], else: [] },
  { id: "post5", kind: "service", connector: "crm", method: "POST", path: "/x" },
] };

test("outward steps are sends, not reads", () => {
  assert.deepEqual(flow.steps.flatMap((s) => [s, ...(s.then || [])]).map(isOutwardStep), [false, true, false, false, true]);
  assert.equal(isOutwardStep({ kind: "service", method: "GET" }), false);
});

test("retry from a step is refused at or before a completed send, and offered after it", () => {
  const led = { find1: { status: "done" }, email2: { status: "done" }, decide3: { status: "done" }, tag4: { status: "failed" } };
  const sentence = "That run already sent something; start a new run to send again.";
  assert.equal(retryFromRefusal(flow, led, "find1"), sentence);
  assert.equal(retryFromRefusal(flow, led, "email2"), sentence);
  assert.equal(retryFromRefusal(flow, led, "decide3"), null);
  assert.equal(retryFromRefusal(flow, led, "tag4"), null);
});

test("with nothing sent yet every step can be retried from; an unknown step cannot", () => {
  const led = { find1: { status: "done" }, email2: { status: "failed" } };
  assert.equal(retryFromRefusal(flow, led, "find1"), null);
  assert.equal(retryFromRefusal(flow, led, "post5"), null);
  assert.match(retryFromRefusal(flow, led, "nope"), /not in this Flow/);
});

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("Retry from this step is flows.retry with the run and the step", { skip: !strip }, async () => {
  const { runSource } = await import("./run-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input]); return { data: { ok: true } }; };
  await runSource(/** @type {any} */ (call)).retryFromReal("run_9", "tag4");
  assert.deepEqual(seen, [["flows.retry", { run: "run_9", from: "tag4" }]]);
});
