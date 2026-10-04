// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTS, askPhone, endLine, phoneRoute, proofHeader } from "./approvals.js";

/** @param {any[]} statuses */
function box(statuses) {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  let i = 0;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "approvals.request") return { op: "grant.rule_enable", space: input.space, fields: { resource: "r", input_hash: "h" }, payload_hash: "ph" };
    if (tool === "approvals.ask") return { id: "ap_1", payload_hash: "ph", expires_in_s: 300 };
    if (tool === "approvals.status") return statuses[Math.min(i++, statuses.length - 1)];
    throw new Error(tool);
  };
  return { call, seen };
}
const FAST = { sleep: async () => {}, pollMs: 0 };

test("a rule act asks the box for its proof request, opens the ask, waits, and hands back the proof once", async () => {
  const b = box([{ state: "waiting" }, { state: "waiting" }, { state: "approved", proof: { payload_hash: "ph", signature: "s" } }]);
  let waited = 0;
  const r = await askPhone(b.call, { tool: "rules.enable", input: { id: "rule_1" }, space: "spc_abcdefghijkl", onWaiting: () => { waited++; }, ...FAST });
  assert.deepEqual(r, { proof: { payload_hash: "ph", signature: "s" } });
  assert.equal(waited, 1);
  assert.deepEqual(b.seen.slice(0, 2), [
    { tool: "approvals.request", input: { space: "spc_abcdefghijkl", call: "ruleEnable", args: ["rule_1"] } },
    { tool: "approvals.ask", input: { op: "grant.rule_enable", space: "spc_abcdefghijkl", fields: { resource: "r", input_hash: "h" } } },
  ]);
  assert.equal(b.seen.filter((x) => x.tool === "approvals.status").length, 3);
});

test("a no, an ended ask and a timeout end it with plain words and no proof", async () => {
  assert.deepEqual(await askPhone(box([{ state: "refused" }]).call, { tool: "rules.remove", input: { id: "x" }, space: "s", ...FAST }), { ended: "refused" });
  assert.deepEqual(await askPhone(box([{ state: "none" }]).call, { tool: "rules.remove", input: { id: "x" }, space: "s", ...FAST }), { ended: "none" });
  let t = 0;
  assert.deepEqual(await askPhone(box([{ state: "waiting" }]).call, { tool: "rules.remove", input: { id: "x" }, space: "s", ...FAST, now: () => (t += 200_000), limitMs: 300_000 }), { ended: "timeout" });
  assert.match(endLine("refused"), /Nothing changed/);
  assert.match(endLine("timeout"), /in time/);
});

test("only acts the kernel's proof table covers take the phone route, and the proof rides as base64url JSON", async () => {
  assert.deepEqual(Object.keys(ACTS).sort(), ["rules.accept", "rules.define", "rules.disable", "rules.dismiss", "rules.enable", "rules.remove"]);
  assert.equal(phoneRoute("rules.enable", { code: "needs_presence" }), true);
  assert.equal(phoneRoute("rules.enable", { code: "not_found" }), false);
  assert.equal(phoneRoute("vault.put", { code: "presence_required" }), false);
  assert.deepEqual(ACTS["rules.define"]({ rule: { kind: "never" } }), { call: "ruleSet", args: [{ kind: "never" }] });
  const h = proofHeader({ a: "é" });
  assert.match(h, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString("utf8")), { a: "é" });
  assert.throws(() => proofHeader({ big: "x".repeat(5000) }), /too large/);
  await assert.rejects(askPhone(box([]).call, { tool: "vault.put", input: {}, space: "s" }), /no phone approval/);
});
