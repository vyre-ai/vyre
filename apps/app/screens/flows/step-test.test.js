// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testLines, pairsOf } from "./step-test-model.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("a step test reads as input, output and what it would send, with a note that nothing happened", () => {
  const l = testLines({ ok: true, input: { to: "a@b.c", subject: "Hi" }, output: { Message: { id: "m1" } }, effects: [{ action: "comms.email", outward: true, would: "would send: Thanks for signing up" }] });
  assert.equal(l.ok, true);
  assert.deepEqual(l.input, [["To", "a@b.c"], ["Subject", "Hi"]]);
  assert.deepEqual(l.output, [["Message · Id", "m1"]]);
  assert.deepEqual(l.effects, ["would send: Thanks for signing up"]);
  assert.equal(l.note, "Nothing was sent. Outward steps are only described.");
});

test("a failed step shows its error in words, and sealed or cut values are not shown", () => {
  assert.equal(testLines({ ok: false, error: { code: "x", message: "The record was not found." } }).error, "The record was not found.");
  assert.deepEqual(pairsOf({ secret: { sealed: true }, big: { cut: true, head: "x" } }), [["Secret", "Sealed"], ["Big", "Too long to show, cut"]]);
  assert.equal(testLines({ ok: true, output: {} }).note, "Nothing was changed.");
});

test("the source sends the flow, step and run (or a sample) and keeps a refusal's words", { skip: !strip }, async () => {
  const { stepTestSource } = await import("./step-test-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input]); return input.step === "no" ? { error: { code: "not_allowed", message: "only an owner or admin" } } : { data: { ok: true } }; };
  const s = stepTestSource(/** @type {any} */ (call));
  await s.test("f1", "email2", { run: "run_9" });
  await s.test({ name: "draft" }, "email2");
  assert.deepEqual(await s.test("f1", "no"), { problem: "only an owner or admin" });
  assert.deepEqual(seen.map((x) => x[1]), [{ flow: "f1", step: "email2", run: "run_9" }, { flow: { name: "draft" }, step: "email2", sample: {} }, { flow: "f1", step: "no", sample: {} }]);
});
