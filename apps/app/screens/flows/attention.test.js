// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersFor, settleInput, rowWords } from "./attention-model.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("a failed run can be retried, skipped or stopped; a quiet wait only stopped; a stage gate moves on with a reason", () => {
  assert.deepEqual(answersFor({ kind: "failed" }).map((a) => a.action), ["retry", "skip", "stop"]);
  assert.deepEqual(answersFor({ kind: "stale" }).map((a) => a.action), ["stop"]);
  assert.deepEqual(answersFor({ kind: "failed", gate: true }), [{ action: "advance", label: "Move on", reason: true }]);
  assert.deepEqual(settleInput("r1", "advance", "  client asked  "), { run: "r1", action: "advance", reason: "client asked" });
  assert.deepEqual(settleInput("r1", "retry"), { run: "r1", action: "retry" });
  assert.deepEqual(rowWords({ label: "Refunds", step_label: "Send note", message: "no sender" }), { title: "Refunds", sub: "Send note: no sender" });
});

test("the source reads attention and sends exactly the settle input; a refusal keeps its words", { skip: !strip }, async () => {
  const { attentionSource } = await import("./attention-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input]); return tool === "flows.settle" && input.action === "stop" ? { error: { code: "person_only", message: "Only a person can stop it." } } : { data: { runs: [{ run: "r1", label: "Refunds" }] } }; };
  const s = attentionSource(/** @type {any} */ (call));
  assert.equal((await s.list()).length, 1);
  assert.deepEqual(await s.settle("r1", "retry"), { refresh: true });
  assert.deepEqual(await s.settle("r1", "stop"), { refresh: false, message: "Only a person can stop it." });
  assert.deepEqual(seen.map((x) => x[0]), ["flows.attention", "flows.settle", "flows.settle"]);
});
