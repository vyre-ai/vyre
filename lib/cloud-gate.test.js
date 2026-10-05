import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cloudGate, forgetCloudGate } from "./cloud-gate.js";

test("cloud gate: a Basic space is refused with the Cloud spaces listed; Cloud, no answer and an error are not refused; the words never say Pro or server", async () => {
  forgetCloudGate();
  const basic = { call: async (/** @type {string} */ tool, /** @type {any} */ input) => (tool === "spaces.tier" ? { data: { tier: "basic", cloud: [{ id: "spc_a", name: "harlow.example", label: "harlow", secret: "x" }, { id: "spc_b" }] } } : { error: { code: "no_such_tool" } }) };
  const g = await cloudGate(basic, "spc_home");
  assert.ok(g);
  assert.equal(g.code, "needs_cloud");
  assert.equal(g.message, "Planner needs a Cloud space");
  assert.deepEqual(g.detail, { tier: "basic", spaces: [{ id: "spc_a", name: "harlow.example", label: "harlow" }, { id: "spc_b", name: null, label: null }] }, "only what a screen needs");
  assert.doesNotMatch(g.message, /\b(pro|server)\b/i);
  for (const [i, answer] of [[1, { data: { tier: "cloud", cloud: [] } }], [2, { error: { code: "no_such_tool" } }], [3, null]]) {
    forgetCloudGate();
    assert.equal(await cloudGate({ call: async () => answer }, `spc_${i}`), null);
  }
  forgetCloudGate();
  assert.equal(await cloudGate({ call: async () => { throw new Error("down"); } }, "spc_x"), null, "a failing spaces module is not Basic");
  forgetCloudGate();
});
