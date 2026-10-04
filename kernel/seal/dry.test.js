// @ts-check
// CS-2: the sealing process's presence check takes `dry: true`: every check (key, signature, payload, expiry, the replay lookup) and nothing recorded. The one-yes card checks at answer time with dry and spends
// the proof when the act runs, so a dry pass leaves the nonce unspent, the real call then passes once, and a second real call is `replayed`.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startSealer } from "./client.js";
import { person, signer, tmp, enrolDevice } from "./testing.js";

async function start(t) {
  const dir = tmp("dry"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const FIELDS = { task: "t1", payload_hash: "ph", decision: "dec_1" };

test("dry: every check runs and nothing is spent; the real call then passes once and a second real call is replayed", async t => {
  const s = await start(t), who = "per_alex", sg = signer(who), ch = person(who);
  await enrolDevice(s, sg);
  const proof = sg.proof(ch, "task.decide", FIELDS);
  const check = (/** @type {any} */ p, /** @type {boolean} */ dry, /** @type {any} */ f = FIELDS) => s.presenceCheck({ chain: ch, op: "task.decide", fields: f, proof: p, ...(dry ? { dry: true } : {}) });
  assert.equal(await check(proof, true), null, "a dry check passes");
  assert.equal(await check(proof, true), null, "and again: it recorded nothing");
  assert.equal(await check(proof, false), null, "the real call still passes, once");
  assert.equal(await check(proof, false), "replayed", "a second real call is a replay");
  assert.equal(await check(proof, true), "replayed", "a dry check sees the spent nonce too");
});

test("dry: it does every check, so a bad proof is refused dry for the same reason as for real", async t => {
  const s = await start(t), who = "per_alex", sg = signer(who), ch = person(who);
  await enrolDevice(s, sg);
  const check = (/** @type {any} */ p, /** @type {any} */ f = FIELDS) => s.presenceCheck({ chain: ch, op: "task.decide", fields: f, proof: p, dry: true });
  assert.equal(await check(sg.proof(ch, "task.decide", FIELDS, { tamper: true })), "bad_signature");
  assert.equal(await check(sg.proof(ch, "task.decide", FIELDS), { ...FIELDS, payload_hash: "other" }), "wrong_payload");
  assert.equal(await check(sg.proof(ch, "task.decide", FIELDS, { issued: Date.now() - 600_000 })), "expired");
  assert.equal(await check({ ...sg.proof(ch, "task.decide", FIELDS), key_id: "dk_00000000" }), "unknown_key");
  assert.equal(await check(sg.proof(ch, "task.decide", FIELDS)), null, "none of those spent anything");
});
