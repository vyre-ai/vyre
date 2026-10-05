// @ts-check
// UY-2 (ruling 6410c6a): on a RELEASE build (a sealing process with no dev switch) an unattested enclave or Android Keystore key enrols and says yes, marked `unattested`; an attested key keeps `attested`;
// a software key and any other unattested signer stay refused.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startSealer } from "./client.js";
import { person, signer, tmp, enrolDevice } from "./testing.js";

const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);
async function release(t) {
  const dir = tmp("unatt"), s = startSealer({ dir, timeoutMs: 8000 }); // no dev, no unattested, no software: what a packaged build starts
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const FIELDS = { task: "t1", payload_hash: "ph", decision: "dec_1" };

test("release: an unattested Secure Enclave key and an unattested Keystore key enrol, say yes, and are marked unattested (never hardware, never attested)", async t => {
  const s = await release(t);
  for (const kind of ["secure_enclave", "strongbox"]) {
    const who = "per_" + kind, sg = signer(who, undefined, kind), ch = person(who);
    const e = await enrolDevice(s, sg);
    assert.equal(e.attested, false, kind);
    assert.equal(e.strength, "unattested", `${kind}: enrol says unattested`);
    assert.equal(e.event.method, "unattested");
    const r = await s.presenceProve({ chain: ch, op: "task.decide", fields: FIELDS, proof: sg.proof(ch, "task.decide", FIELDS) });
    assert.deepEqual(r, { ok: true, method: "unattested", strength: "unattested" }, `${kind}: yes() accepts it and says how it was proved`);
    assert.equal(await s.presenceCheck({ chain: ch, op: "task.decide", fields: FIELDS, proof: sg.proof(ch, "task.decide", FIELDS) }), null);
  }
});

test("release: a software key and any other unattested signer are refused (tpm included: see tpm-signer.test.js)", async t => {
  const s = await release(t);
  assert.equal(await code(enrolDevice(s, signer("per_sw", undefined, "software"))), "software_refused");
  assert.equal(await code(enrolDevice(s, signer("per_tpm", undefined, "tpm"))), "unattested");
  assert.equal(await code(enrolDevice(s, signer("per_wh", undefined, "windows_hello"))), "unattested");
});

test("release: an attested key keeps its own mark", async t => {
  const dir = tmp("unatt-att"), verifiers = path.join(dir, "verifiers.mjs");
  fs.writeFileSync(verifiers, 'export default { fake: (att, spki) => (att.claims === "enclave" ? "secure_enclave" : null) };');
  const s = startSealer({ dir, timeoutMs: 8000, verifiers });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const who = "per_att", sg = signer(who), ch = person(who);
  const e = await enrolDevice(s, sg, { attestation: { format: "fake", claims: "enclave" } });
  assert.equal(e.attested, true);
  assert.equal(e.strength, "hardware");
  assert.deepEqual(await s.presenceProve({ chain: ch, op: "task.decide", fields: FIELDS, proof: sg.proof(ch, "task.decide", FIELDS) }), { ok: true, method: "attested", strength: "hardware" });
});
