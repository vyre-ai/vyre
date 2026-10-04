// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadHash as kernelHash } from "../../../../kernel/seal/wire.js";
import { answerRefusal, approveCard, askedLine, cardsFrom, factLines, refuseCard } from "./phone-approve.js";

const FIELDS = { resource: "vyre://s/rule/r1", input_hash: "abc" };
const PH = kernelHash("grant.rule_disable", "spc_abcdefghijkl", FIELDS);
const CARD = { id: "ap_1", title: "Turn a rule off", body: "Approve with Face ID.", op: "grant.rule_disable", space: "spc_abcdefghijkl", fields: FIELDS, payload_hash: PH, asked_from: "web", expires_in_s: 240 };
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
  assert.deepEqual(calls[0], ["sign", { op: "grant.rule_disable", space: "spc_abcdefghijkl", fields: CARD.fields, payload_hash: PH, prompt: "Turn a rule off" }]);
  assert.deepEqual(calls[1], ["approvals.answer", { id: "ap_1", approve: true }, { kernelProof: `H({"payload_hash":"${PH}","signature":"sig"})` }]);
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

test("AP-1: a card whose hash is not the hash of the fields it shows is refused before Face ID is asked", async () => {
  let signed = 0;
  const signer = { signPresence: async (/** @type {any} */ r) => { signed++; return { payload_hash: r.payload_hash }; } };
  const call = async () => { throw new Error("must not be called"); };
  const other = kernelHash("grant.rule_remove", "spc_abcdefghijkl", FIELDS);
  await assert.rejects(approveCard({ ...CARD, payload_hash: other }, signer, call, header), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveCard({ ...CARD, fields: { ...FIELDS, input_hash: "evil" } }, signer, call, header), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveCard({ ...CARD, op: "grant.rule_remove" }, signer, call, header), (/** @type {any} */ e) => e.code === "hash_mismatch");
  assert.equal(signed, 0);
  assert.match(answerRefusal("hash_mismatch"), /does not match/);
});

test("the app's payload hash is the kernel's, byte for byte, on several shapes", async () => {
  const { payloadHash } = await import("./payload-hash.js");
  for (const [op, space, fields] of [["grant.rule_set", "spc_aaaaaaaaaaaa", { resource: "r", input_hash: "h" }], ["grant.role", "spc_bbbbbbbbbbbb", { n: 1, list: [1, { z: 2, a: null }], s: "é\"" }], ["task.decide", "spc_cccccccccccc", {}]])
    assert.equal(payloadHash(/** @type {string} */ (op), /** @type {string} */ (space), /** @type {any} */ (fields)), kernelHash(/** @type {string} */ (op), /** @type {string} */ (space), /** @type {any} */ (fields)));
});

test("WH-1: a card whose fields carry an op or space key is refused before Face ID, and nothing is signed", async () => {
  let signed = 0;
  const signer = { signPresence: async (/** @type {any} */ r) => { signed++; return { payload_hash: r.payload_hash }; } };
  const call = async () => { throw new Error("must not be called"); };
  // (op a, fields {op: b}) hashes like (op b, fields {}): the hash matches, the card would still show the wrong act.
  const evil = { ...CARD, op: "grant.rule_disable", fields: { op: "grant.rule_remove" }, payload_hash: kernelHash("grant.rule_remove", CARD.space, {}) };
  await assert.rejects(approveCard(evil, signer, call, header), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveCard({ ...CARD, fields: { ...FIELDS, space: "spc_zzzzzzzzzzzz" } }, signer, call, header), (/** @type {any} */ e) => e.code === "hash_mismatch");
  assert.equal(signed, 0);
});
