// @ts-check
// R031-95 2.2: a lease request signed by the computer. The sealing process checks it with the one verifier every yes goes through: a key of THIS person, bound to the listed device the hello names, over exact
// fields (device, key, limit, runner version, protocol), single use. Nothing else is accepted when the home asks for it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { startSealer } from "./client.js";
import { joinBytes } from "./wire.js";
import { person, withAgent, signer, tmp, SPACE } from "./testing.js";
import { makeGenesis, eidOf, b64u } from "../identity/chain.js";

const code = p => p.then(() => null, e => e.code);
const INVITE = "inv_" + "a".repeat(32);
const edKey = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32), eid = await eidOf(pub);
  return { eid, pub: b64u(pub), sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: b64u(pub) }) };
};
/** A sealing process with one person whose presence key is bound to a listed device (the Mac), the way a joined invitee's is. */
async function world(t) {
  const dir = tmp("hello"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const mac = await edKey(), rc = await edKey(), t0 = Date.now() - 2 * 86_400_000;
  const ops = [await makeGenesis({ kind: "person", entry: mac.entry("device"), code: rc.entry("code"), nonce: "nonce-" + crypto.randomBytes(4).toString("hex"), ts: t0, sign: mac.sign })];
  const id = ops[0].id, sg = signer(id), ch = person(id);
  await s.join({ chain: ch, person: id, ops, bind: { eid: mac.eid, sig: b64u(mac.sign(joinBytes(INVITE, SPACE, id, sg.key_id, sg.enrolment.spki))) }, invite: INVITE, key_id: sg.key_id, spki: sg.enrolment.spki, signer: sg.enrolment.signer });
  const hello = (extra = {}) => ({ device: "dev_mac", device_key: "dev_mac", eid: mac.eid, cap: "provider", runner_version: "0.3.2", protocol: 1, ...extra });
  const ask = (h, o = {}) => s.lease.issue({ chain: o.chain || ch, space: SPACE, device: "dev_mac", allowed: true, signed: true, hello: h, proof: "proof" in o ? o.proof : sg.proof(o.chain || ch, "lease.issue", h) });
  return { s, mac, id, sg, ch, hello, ask };
}

test("a signed hello from the person's key on the listed device is issued a lease", async t => {
  const w = await world(t), h = w.hello();
  const r = await w.ask(h);
  assert.equal(Buffer.from(r.key, "base64").length, 32);
  assert.equal((await w.s.lease.check({ chain: w.ch, id: r.id })).device, "dev_mac");
});

test("no proof asks for one; a model, another person, and a proof for other fields are refused", async t => {
  const w = await world(t), h = w.hello();
  assert.equal(await code(w.ask(h, { proof: undefined })), "needs_presence");
  assert.equal(await code(w.ask(h, { chain: withAgent(w.id) })), "human_only");
  assert.equal(await code(w.ask(h, { proof: w.sg.proof(w.ch, "lease.issue", w.hello({ cap: "internet" })) })), "wrong_payload", "the limit is in the signed fields: a proof for internet is no use for provider");
  assert.equal(await code(w.ask(h, { proof: w.sg.proof(w.ch, "lease.issue", w.hello({ protocol: 2 })) })), "wrong_payload");
  assert.equal(await code(w.ask(h, { proof: w.sg.proof(w.ch, "lease.reinstate", h) })), "wrong_decision", "a proof for another act");
  const stranger = signer("per_stranger");
  assert.equal(await code(w.ask(h, { proof: stranger.proof(w.ch, "lease.issue", h) })), "unknown_key");
});

test("a request with no hello gets a key from no one, and the answer \"no\" needs no proof", async t => {
  const w = await world(t);
  assert.equal(await code(w.s.lease.issue({ chain: w.ch, space: SPACE, device: "dev_mac", allowed: true, signed: true })), "needs_presence", "the probe is told to sign");
  assert.deepEqual(await w.s.lease.issue({ chain: w.ch, space: SPACE, device: "dev_mac", allowed: false, signed: true }), { revoked: true }, "no Offer: no key, no proof asked");
  const a = await w.ask(w.hello()); await w.s.lease.revoke({ chain: w.ch, member: w.id, device: "dev_mac" });
  assert.deepEqual(await w.s.lease.issue({ chain: w.ch, space: SPACE, device: "dev_mac", allowed: true, signed: true }), { revoked: true }, "a revoked computer reads as revoked, signed or not");
  assert.ok(a.id);
});

test("a proof is single use", async t => {
  const w = await world(t), h = w.hello(), proof = w.sg.proof(w.ch, "lease.issue", h);
  await w.ask(h, { proof });
  assert.equal(await code(w.ask(h, { proof })), "replayed");
});

test("the key must be listed for the computer the hello names", async t => {
  const w = await world(t), other = await edKey();
  assert.equal(await code(w.ask(w.hello({ eid: other.eid }))), "wrong_device", "the person's key is bound to the Mac, not to this other entry");
  assert.equal(await code(w.s.lease.issue({ chain: w.ch, space: SPACE, device: "dev_other", allowed: true, signed: true, hello: w.hello(), proof: w.sg.proof(w.ch, "lease.issue", w.hello()) })), "bad_input", "the hello names another computer than the lease");
});

test("without the home asking for it, a lease needs no proof (the flag is the kernel's)", async t => {
  const w = await world(t);
  assert.equal(Buffer.from((await w.s.lease.issue({ chain: w.ch, space: SPACE, device: "dev_mac", allowed: true })).key, "base64").length, 32);
});
