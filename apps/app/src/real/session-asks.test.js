// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_LIFE_MS, SESSION_ANSWER, answerSession, askFacts, askTitle, sessionRefusal, withPending } from "./session-asks.js";
import { payloadHash } from "./payload-hash.js";

const row = (id, over = {}) => ({ id, device: "dev1", line: "Vyre on browser wants to reveal or use \"Bank\" in your vault", moment: "vault", request: { op: "vault.reveal", fields: { name: "Bank" } }, asked_at: 1, ...over });
const SPACE = "spc_abcdefghijkl";

test("the pending answer gives one card each, titled with the server's own line", () => {
  const l = withPending([], { asks: [row("a1"), row("a1"), row("a2")] }, 1000);
  assert.deepEqual(l.map((a) => a.id), ["a1", "a2"]);
  assert.match(askTitle(l[0]), /wants to reveal or use "Bank" in your vault/);
  assert.deepEqual(askFacts(l[0]), ["name: Bank"]);
});

test("rows with no request are ignored, a missing line has our own, and gone asks drop out", () => {
  assert.deepEqual(withPending([], { asks: [{ id: "x" }] }, 1), []);
  assert.equal(askTitle(withPending([], { asks: [row("a", { line: "" })] }, 1)[0]), "A device is asking for your yes");
  const l = withPending([], { asks: [row("a1")] }, 1000);
  assert.deepEqual(withPending(l, { asks: [] }, 2000), []);
  assert.deepEqual(withPending(l, undefined, 2000), []);
});

test("an ask keeps its first-seen time and ends after five minutes", () => {
  const l = withPending([], { asks: [row("a1")] }, 0);
  assert.deepEqual(withPending(l, { asks: [row("a1")] }, ASK_LIFE_MS + 1), []);
});

test("Allow signs the exact request and sends the proof with yes", async () => {
  const a = withPending([], { asks: [row("a1")] }, 1)[0];
  const hash = payloadHash("vault.reveal", SPACE, { name: "Bank" });
  /** @type {any[]} */ const seen = []; /** @type {any[]} */ const signed = [];
  const signer = { signPresence: async (/** @type {any} */ r) => { signed.push(r); return { payload_hash: r.payload_hash, sig: "s" }; } };
  const say = await answerSession(a, true, async (t, i) => { seen.push([t, i]); return {}; }, { signer, person: "per_1", space: SPACE });
  assert.equal(say, "Allowed.");
  assert.equal(signed[0].payload_hash, hash); assert.equal(signed[0].op, "vault.reveal"); assert.deepEqual(signed[0].fields, { name: "Bank" });
  assert.deepEqual(seen, [[SESSION_ANSWER, { id: "a1", yes: true, proof: { payload_hash: hash, sig: "s" } }]]);
});

test("Don't allow sends no proof, and a proof for another payload is never sent", async () => {
  const a = withPending([], { asks: [row("a1")] }, 1)[0];
  /** @type {any[]} */ const seen = [];
  assert.match(await answerSession(a, false, async (t, i) => { seen.push(i); return {}; }), /Not allowed/);
  assert.deepEqual(seen, [{ id: "a1", yes: false }]);
  await assert.rejects(answerSession(a, true, async () => ({}), { signer: { signPresence: async () => ({ payload_hash: "other" }) }, person: "p", space: SPACE }), (/** @type {any} */ e) => e.code === "needs_presence");
  await assert.rejects(answerSession(a, true, async () => ({}), { signer: null, person: "p", space: SPACE }), (/** @type {any} */ e) => e.code === "no_signer");
});

test("a failed answer has our words", () => {
  assert.match(sessionRefusal("software_key"), /key in your phone/);
  assert.match(sessionRefusal("expired"), /ended/);
  assert.match(sessionRefusal("ERR_CANCELED"), /Cancelled/);
});
