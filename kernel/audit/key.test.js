import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import * as C from "../identity/chain.js";
import { endorse, verifyEndorsement, sealerKey, publicKeyOf } from "./key.js";
import { createCheckpointer, createDeviceCheckpoints, verifyLog } from "./index.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { startSealer } from "../seal/client.js";
import { tmp, person } from "../seal/testing.js";

const H = 3_600_000, T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
async function key(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const eid = await C.eidOf(pub);
  const pubText = Buffer.from(pub).toString("base64url");
  return { label, pub: pubText, eid, sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: pubText, label }) };
}
/** An owner (alex, with a phone), and a Space whose list holds alex. */
async function world() {
  const phone = await key("phone");
  const g0 = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), nonce: "n-alex-phone", ts: T0, sign: phone.sign });
  const alex = { ops: [g0], state: await C.verifyChain([g0], { now: T0 }) };
  const chains = new Map([[alex.state.id, alex.ops]]);
  const ownerOps = async id => chains.get(id) || null;
  const viaPos = await C.viaOf(alex.ops);
  const g = await C.makeGenesis({ kind: "space", entry: { eid: alex.state.id, kind: "owner", subject: alex.state.id, label: "Alex" }, nonce: "space-nonce-1", ts: T0 + H, via: phone.eid, viaPos, sign: phone.sign });
  return { phone, alex, space: [g], spaceId: (await C.verifyChain([g], { now: T0 + H, ownerOps })).id, ownerOps, viaPos, chains };
}

test("the Space key is held by the sealing process, signs only this Space's checkpoints, and never leaves", async t => {
  const dir = tmp("spk"), s = startSealer({ dir, timeoutMs: 8000, dev: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ch = person("per_alex");
  const k = await sealerKey(s, ch);
  assert.match(k.key_id, /^[0-9a-f]{16}$/);
  const again = await s.spaceKey.pub({ chain: ch });
  assert.equal(again.pub, k.pub, "one key per Space, kept");
  const pub = publicKeyOf(k.pub);
  const log = createEventLog({ space: ch.space, clock: Date.now });
  const kernelChains = createChainBuilder({ space: ch.space, owner: "per_alex", owner_uid: 1, key: Buffer.alloc(32, 2) });
  log.append(kernelChains.fromFacts({ kind: "module", module: "x", first_party: true }), { type: "note.added", sv: 1, subject: `vyre://${ch.space}/note/1`, data: {} });
  const cp = createCheckpointer({ space: ch.space, log, chains: kernelChains, sign: k.sign, key_id: k.key_id });
  const c = await cp.sign();
  assert.ok(verifyLog({ space: ch.space, log, publicKey: pub }).ok, "a checkpoint signed in the sealing process verifies under its public key");
  // it signs nothing else, and nothing for another Space
  await assert.rejects(() => s.spaceKey.sign({ chain: ch, bytes: Buffer.from("anything at all") }), { code: "bad_input" });
  const other = Buffer.from("vyre-checkpoint-v1\n" + JSON.stringify({ space: "spc_otherspace0001", seq: 1, hash: "h", time: 1, key_id: k.key_id }));
  await assert.rejects(() => s.spaceKey.sign({ chain: ch, bytes: other }), { code: "wrong_space" });
  assert.ok(c.signature);
});

test("an owner's device endorses the key, and a device accepts it only through the Space's identity chain", async () => {
  const w = await world();
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const kid = crypto.createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex").slice(0, 16);
  const key0 = { space: w.spaceId, key_id: kid, pub: spki };
  const e = await endorse(key0, { by: w.alex.state.id, via: w.phone.eid, viaPos: w.viaPos, ts: T0 + 2 * H, sign: w.phone.sign });
  const ctx = { ownerOps: w.ownerOps, now: T0 + 10 * H };
  assert.deepEqual(await verifyEndorsement(w.space, e, ctx), key0);
  const swapped = { ...e, pub: crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  await assert.rejects(() => verifyEndorsement(w.space, swapped, ctx), { code: "bad_endorsement" });
  const stranger = await key("stranger");
  const forged = await endorse(key0, { by: w.alex.state.id, via: stranger.eid, viaPos: w.viaPos, ts: T0 + 2 * H, sign: stranger.sign });
  await assert.rejects(() => verifyEndorsement(w.space, forged, ctx), { code: "bad_endorsement" });
  await assert.rejects(() => verifyEndorsement(w.space, { ...e, space: "spc_" + "a".repeat(26) }, ctx), { code: "bad_endorsement" });
  const notOwner = await endorse(key0, { by: "per_" + "b".repeat(26), via: w.phone.eid, viaPos: w.viaPos, ts: T0 + 2 * H, sign: w.phone.sign });
  await assert.rejects(() => verifyEndorsement(w.space, notOwner, ctx), { code: "bad_endorsement" });
  await assert.rejects(() => verifyEndorsement(w.space, { ...e, ts: T0 }, ctx), { code: "bad_endorsement" });
  const dev = createDeviceCheckpoints({ space: w.spaceId, publicKey: publicKeyOf(key0.pub) });
  assert.deepEqual(dev.accept({ space: w.spaceId, seq: 1, hash: "h", time: 1, key_id: kid, signature: "AAAA" }), { ok: false, why: "bad_signature" });
});

test("the key id the sealing process reports is the one the endorsement check recomputes", async t => {
  const dir = tmp("spk2"), s = startSealer({ dir, timeoutMs: 8000, dev: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const k = await sealerKey(s, person("per_alex"));
  assert.equal(crypto.createHash("sha256").update(Buffer.from(k.pub, "base64")).digest("hex").slice(0, 16), k.key_id);
});

import { revokeKey, verifyRevocation } from "./key.js";
test("any owner revokes the checkpoint key through the chain; a device then refuses it, and notices a home gone quiet", async () => {
  const w = await world();
  const k = crypto.generateKeyPairSync("ed25519");
  const spki = k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const kid = crypto.createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex").slice(0, 16);
  const ctx = { ownerOps: w.ownerOps, now: T0 + 10 * H };
  const rev = await revokeKey({ space: w.spaceId, key_id: kid }, { by: w.alex.state.id, via: w.phone.eid, viaPos: w.viaPos, ts: T0 + 3 * H, sign: w.phone.sign });
  assert.deepEqual(await verifyRevocation(w.space, rev, ctx), { space: w.spaceId, key_id: kid });
  const stranger = await key("stranger");
  const forged = await revokeKey({ space: w.spaceId, key_id: kid }, { by: w.alex.state.id, via: stranger.eid, viaPos: w.viaPos, ts: T0 + 3 * H, sign: stranger.sign });
  await assert.rejects(() => verifyRevocation(w.space, forged, ctx), { code: "bad_revocation" });
  // the device: a checkpoint under a revoked key is refused, and a held one goes stale by the device's own clock
  let now = 1_000_000;
  const log = createEventLog({ space: w.spaceId, clock: () => now });
  const kc = createChainBuilder({ space: w.spaceId, owner: "per_o", owner_uid: 1, key: Buffer.alloc(32, 3) });
  log.append(kc.fromFacts({ kind: "module", module: "x", first_party: true }), { type: "note.added", sv: 1, subject: `vyre://${w.spaceId}/note/1`, data: {} });
  const { ed25519Signer } = await import("./index.js");
  const cp = await createCheckpointer({ space: w.spaceId, log, chains: kc, sign: ed25519Signer(k.privateKey), key_id: kid, clock: () => now, publicKey: k.publicKey }).sign();
  const dev = createDeviceCheckpoints({ space: w.spaceId, publicKey: k.publicKey, clock: () => now });
  assert.equal(dev.staleness().stale, true, "nothing held yet");
  assert.deepEqual(dev.accept(cp), { ok: true });
  assert.equal(dev.staleness().stale, false);
  now += 31 * 60_000;
  assert.equal(dev.staleness().stale, true, "no newer checkpoint for three intervals");
  dev.revoke(kid);
  assert.deepEqual(dev.accept({ ...cp, seq: cp.seq + 1 }), { ok: false, why: "key_revoked" });
  // latest() skips an event that is not a verifying checkpoint
  log.append(kc.fromFacts({ kind: "module", module: "x", first_party: true }), { type: "checkpoint.signed", sv: 1, subject: `vyre://${w.spaceId}/audit/log`, data: { checkpoint: { ...cp, seq: 99, hash: "forged", signature: "AAAA" } } });
  assert.equal(createCheckpointer({ space: w.spaceId, log, chains: kc, sign: () => "", key_id: kid, publicKey: k.publicKey }).latest().seq, cp.seq);
});


test("K5-1: a device the owner removed cannot endorse or revoke, even with a backdated ts (position-based validity)", async () => {
  const w = await world();
  const laptop = await key("laptop");
  // alex adds a laptop, then removes the phone; the old phone signs a backdated endorsement naming the position it knew
  const state0 = await C.verifyChain(w.alex.ops, { now: T0 + 5 * H });
  const add = await C.makeOp(state0, { type: "add", entry: laptop.entry("device") }, { by: w.phone.eid, ts: T0 + 2 * H, sign: w.phone.sign });
  const s1 = await C.applyOp(state0, add, { now: T0 + 2 * H });
  const rem = await C.makeOp(s1, { type: "remove", target: w.phone.eid }, { by: laptop.eid, ts: T0 + 30 * H, sign: laptop.sign });
  w.chains.set(w.alex.state.id, [...w.alex.ops, add, rem]);
  const key0 = { space: w.spaceId, key_id: "0123456789abcdef", pub: crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const kid = crypto.createHash("sha256").update(Buffer.from(key0.pub, "base64")).digest("hex").slice(0, 16);
  key0.key_id = kid;
  const old = await endorse(key0, { by: w.alex.state.id, via: w.phone.eid, viaPos: w.viaPos, ts: T0 + 2 * H, sign: w.phone.sign });
  await assert.rejects(() => verifyEndorsement(w.space, old, { ownerOps: w.ownerOps, now: T0 + 40 * H }), { code: "bad_endorsement" }, "the removed phone");
  const oldRev = await revokeKey(key0, { by: w.alex.state.id, via: w.phone.eid, viaPos: w.viaPos, ts: T0 + 2 * H, sign: w.phone.sign });
  await assert.rejects(() => verifyRevocation(w.space, oldRev, { ownerOps: w.ownerOps, now: T0 + 40 * H }), { code: "bad_revocation" });
  // the laptop, named at the current position, still can
  const cur = await C.viaOf(w.chains.get(w.alex.state.id));
  const ok = await endorse(key0, { by: w.alex.state.id, via: laptop.eid, viaPos: cur, ts: T0 + 31 * H, sign: laptop.sign });
  assert.equal((await verifyEndorsement(w.space, ok, { ownerOps: w.ownerOps, now: T0 + 40 * H })).key_id, kid);
});
