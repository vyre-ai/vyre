// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadHash as kernelHash } from "./payload-hash.js";
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
  assert.deepEqual(await approveCard(CARD, signer, call, header, "per_aaaaaaaaaaaa"), { answered: "approved" });
  assert.deepEqual(calls[0], ["sign", { op: "grant.rule_disable", space: "spc_abcdefghijkl", fields: CARD.fields, payload_hash: PH, prompt: "Turn a rule off", person: "per_aaaaaaaaaaaa" }]);
  assert.deepEqual(calls[1], ["approvals.answer", { id: "ap_1", approve: true }, { kernelProof: `H({"payload_hash":"${PH}","signature":"sig"})` }]);
});

test("no signer, a proof for another card, and a cancelled prompt send nothing and say why", async () => {
  const call = async () => { throw new Error("must not be called"); };
  await assert.rejects(approveCard(CARD, null, call, header, "per_a"), (/** @type {any} */ e) => e.code === "no_signer");
  await assert.rejects(approveCard(CARD, { signPresence: async () => ({ payload_hash: "other" }) }, call, header, "per_a"), (/** @type {any} */ e) => e.code === "needs_presence");
  await assert.rejects(approveCard(CARD, { signPresence: async () => { throw Object.assign(new Error("x"), { code: "ERR_CANCELED" }); } }, call, header, "per_a"), (/** @type {any} */ e) => e.code === "ERR_CANCELED");
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
  await assert.rejects(approveCard({ ...CARD, payload_hash: other }, signer, call, header, "per_a"), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveCard({ ...CARD, fields: { ...FIELDS, input_hash: "evil" } }, signer, call, header, "per_a"), (/** @type {any} */ e) => e.code === "hash_mismatch");
  await assert.rejects(approveCard({ ...CARD, op: "grant.rule_remove" }, signer, call, header, "per_a"), (/** @type {any} */ e) => e.code === "hash_mismatch");
  assert.equal(signed, 0);
  assert.match(answerRefusal("hash_mismatch"), /does not match/);
});

test("the app's payload hash reproduces platform's vector file, case by case (canonical and hash)", async () => {
  const fs = await import("node:fs");
  const { canonical, payloadHash } = await import("./payload-hash.js");
  const file = JSON.parse(fs.readFileSync(new URL("../../../../kernel/seal/payloadhash-vectors.json", import.meta.url), "utf8"));
  assert.ok(file.vectors.length >= 7);
  for (const v of file.vectors) {
    assert.equal(canonical({ op: v.op, space: v.space, fields: v.fields }), v.canonical, v.name);
    assert.equal(payloadHash(v.op, v.space, v.fields), v.hash, v.name);
  }
});

test("WH-1 (nested form): fields named op or space cannot stand in for the real ones", async () => {
  const { payloadHash } = await import("./payload-hash.js");
  assert.notEqual(payloadHash("a", "spc_aaaaaaaaaaaa", { op: "b" }), payloadHash("b", "spc_aaaaaaaaaaaa", {}));
  const card = { ...CARD, op: "grant.role", fields: { op: "grant.invite", space: "spc_bbbbbbbbbbbb" }, payload_hash: payloadHash("grant.role", CARD.space, { op: "grant.invite", space: "spc_bbbbbbbbbbbb" }) };
  const signer = { signPresence: async (/** @type {any} */ r) => ({ payload_hash: r.payload_hash }) };
  assert.deepEqual(await approveCard(card, signer, async () => ({ answered: "approved" }), header, "per_a"), { answered: "approved" });
  // and a hash that is not the nested hash of what the card shows is refused
  const old = { ...card, payload_hash: "p7RnC0xh9eBykRqVvO7qWpbuYDGEgyOAdJkbiN57LEo" };
  await assert.rejects(approveCard(old, signer, async () => ({}), header, "per_a"), (/** @type {any} */ e) => e.code === "hash_mismatch");
});

test("the key module needs the person's id, so a phone that does not know it signs nothing", async () => {
  const signer = { signPresence: async () => { throw new Error("must not sign"); } };
  await assert.rejects(approveCard(CARD, signer, async () => ({}), header), (/** @type {any} */ e) => e.code === "no_person");
  assert.match(answerRefusal("ERR_NO_PERSON"), /sign in/);
  assert.match(answerRefusal("ERR_PAYLOAD_MISMATCH"), /does not match/);
});

test("the canonical bytes the app hashes are the bytes in vault's fixed proofbytes vectors (a one-byte difference locks iPhones out)", async () => {
  const fs = await import("node:fs");
  const { canonical } = await import("./payload-hash.js");
  const file = JSON.parse(fs.readFileSync(new URL("../../../../kernel/seal/proofbytes-vectors.json", import.meta.url), "utf8"));
  assert.ok(file.vectors.length >= 3);
  for (const v of file.vectors) {
    const { signature, assertion, ...rest } = v.proof;
    assert.equal(canonical(rest), v.bytes);
  }
});
