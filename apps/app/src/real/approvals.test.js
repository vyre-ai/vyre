// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadHash as kernelHash } from "./payload-hash.js";
import { ACTS, askPhone, endLine, heldAsk, phoneRoute, proofHeader, askYes } from "./approvals.js";

/** @param {any[]} statuses */
function box(statuses, tamper = "") {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  let i = 0;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    const F = { resource: "r", input_hash: "h" };
    if (tool === "approvals.request") return { op: "grant.rule_enable", space: input.space, fields: F, payload_hash: tamper === "request" ? "forged" : kernelHash("grant.rule_enable", input.space, F) };
    if (tool === "approvals.ask") return { id: "ap_1", payload_hash: tamper === "ask" ? "other" : kernelHash("grant.rule_enable", input.space, F), expires_in_s: 300 };
    if (tool === "approvals.status") return statuses[Math.min(i++, statuses.length - 1)];
    throw new Error(tool);
  };
  return { call, seen };
}
const FAST = { sleep: async () => {}, pollMs: 0 };

test("a rule act asks the box for its proof request, opens the ask, waits, and hands back the proof once", async () => {
  const b = box([{ state: "waiting" }, { state: "waiting" }, { state: "approved", proof: { payload_hash: "x", signature: "s" } }]);
  let waited = 0;
  const r = await askPhone(b.call, { tool: "rules.enable", input: { id: "rule_1" }, space: "spc_abcdefghijkl", onWaiting: () => { waited++; }, ...FAST });
  assert.deepEqual(r, { proof: { payload_hash: "x", signature: "s" } });
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
  assert.deepEqual(Object.keys(ACTS).sort(), ["rules.accept", "rules.define", "rules.disable", "rules.dismiss", "rules.enable", "rules.remove", "spaces.invites.confirm", "spaces.invites.create", "spaces.members.remove", "spaces.members.set-role"]);
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

test("AP-1 on the asking side: a proof request or an ask whose hash is not the hash of its fields is refused", async () => {
  await assert.rejects(askPhone(box([{ state: "waiting" }], "request").call, { tool: "rules.enable", input: { id: "r" }, space: "spc_abcdefghijkl", ...FAST }), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(askPhone(box([{ state: "waiting" }], "ask").call, { tool: "rules.enable", input: { id: "r" }, space: "spc_abcdefghijkl", ...FAST }), (/** @type {any} */ e) => e.code === "hash_mismatch");
});

test("a held act names its moment and request, nothing else counts", () => {
  assert.deepEqual(heldAsk({ code: "held", detail: { moment: "vault", request: { op: "vault.reveal", fields: { name: "Bank" } } } }), { moment: "vault", request: { op: "vault.reveal", fields: { name: "Bank" } } });
  assert.equal(heldAsk({ code: "held", detail: { moment: "nope", request: { op: "x" } } }), null);
  assert.equal(heldAsk({ code: "needs_presence", detail: { moment: "vault", request: { op: "x" } } }), null);
  assert.equal(heldAsk(null), null);
});

test("asking for the yes: ask, poll, and return the card id for one retry, with no proof carried", async () => {
  const calls = [];
  const states = [{ state: "waiting" }, { state: "approved", card: "ap_1" }];
  let i = 0;
  const call = async (t, input) => { calls.push([t, input]); return t === "presence.person.session-ask" ? { id: "ap_1" } : states[Math.min(i++, 1)]; };
  let said = "";
  assert.deepEqual(await askYes(call, { moment: "vault", request: { op: "vault.reveal", fields: {} }, sleep: async () => {}, pollMs: 0, onWaiting: (l) => { said = l; } }), { card: "ap_1" });
  assert.deepEqual(calls[0], ["presence.person.session-ask", { moment: "vault", request: { op: "vault.reveal", fields: {} } }]);
  assert.deepEqual(calls[1], ["presence.person.session-status", { id: "ap_1" }]);
  assert.equal(said, "");
});

test("a no, a timeout and Stop waiting end it without an approval", async () => {
  const ask = (state) => async (t) => (t === "presence.person.session-ask" ? { id: "a" } : { state });
  const o = { moment: "outward", request: { op: "mail.send", fields: {} }, sleep: async () => {} };
  assert.deepEqual(await askYes(ask("refused"), o), { ended: "refused" });
  assert.deepEqual(await askYes(ask("timeout"), o), { ended: "timeout" });
  assert.deepEqual(await askYes(ask("waiting"), { ...o, signal: { stopped: true } }), { ended: "none" });
  await assert.rejects(askYes(async () => ({}), o), (e) => e.code === "ask_failed");
});
