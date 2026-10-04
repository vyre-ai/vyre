// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerRefusal, approveCard, askedLine, cardsFrom, factLines, refuseCard } from "./phone-approve.js";

const CARD = { id: "ap_1", title: "Turn a rule off", body: "Approve with Face ID.", op: "grant.rule_disable", space: "spc_abcdefghijkl", fields: { resource: "vyre://s/rule/r1", input_hash: "abc" }, payload_hash: "ph1", asked_from: "web", expires_in_s: 240 };
const header = (/** @type {unknown} */ p) => `H(${JSON.stringify(p)})`;

test("the pending list becomes cards, with every signed field shown as given", () => {
  assert.deepEqual(cardsFrom({ approvals: [CARD, { id: "x" }, null] }).map((c) => c.id), ["ap_1"]);
  assert.deepEqual(cardsFrom(null), []);
  assert.deepEqual(factLines(CARD), ["resource: vyre://s/rule/r1", "input hash: abc"]);
  assert.equal(askedLine(CARD), "Asked from web, ends in 4 min");
});

test("approving signs the card's payload hash with the fake Face ID key and sends the proof beside approvals.answer", async () => {
  /** @type {any[]} */ const calls = [];
  const signer = { signPresence: async (/** @type {any} */ r) => { calls.push(["sign", r]); return { payload_hash: r.payload_hash, signature: "sig" }; } };
  const call = async (/** @type {string} */ t, /** @type {any} */ i, /** @type {any} */ o) => { calls.push([t, i, o]); return { answered: "approved" }; };
  assert.deepEqual(await approveCard(CARD, signer, call, header), { answered: "approved" });
  assert.deepEqual(calls[0], ["sign", { op: "grant.rule_disable", space: "spc_abcdefghijkl", fields: CARD.fields, payload_hash: "ph1", prompt: "Turn a rule off" }]);
  assert.deepEqual(calls[1], ["approvals.answer", { id: "ap_1", approve: true }, { kernelProof: 'H({"payload_hash":"ph1","signature":"sig"})' }]);
});

test("no signer, a proof for another card, and a cancelled prompt send nothing and say why", async () => {
  const call = async () => { throw new Error("must not be called"); };
  await assert.rejects(approveCard(CARD, null, call, header), (/** @type {any} */ e) => e.code === "no_signer");
  await assert.rejects(approveCard(CARD, { signPresence: async () => ({ payload_hash: "other" }) }, call, header), (/** @type {any} */ e) => e.code === "needs_presence");
  await assert.rejects(approveCard(CARD, { signPresence: async () => { throw Object.assign(new Error("x"), { code: "ERR_CANCELED" }); } }, call, header), (/** @type {any} */ e) => e.code === "ERR_CANCELED");
  assert.match(answerRefusal("ERR_CANCELED"), /Nothing was approved/);
  assert.match(answerRefusal("no_signer"), /Update Vyre/);
  assert.match(answerRefusal("ERR_KEY_INVALIDATED"), /sign in/i);
});

test("saying no signs nothing", async () => {
  /** @type {any[]} */ const calls = [];
  await refuseCard(CARD, async (t, i) => { calls.push([t, i]); return { answered: "refused" }; });
  assert.deepEqual(calls, [["approvals.answer", { id: "ap_1", approve: false }]]);
});
