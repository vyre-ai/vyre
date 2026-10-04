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
