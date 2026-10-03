// @ts-check
// R-8: the way back for presence keys, matched to the Wink identity design (DESIGN-wink section 2). The process verifies the person's identity chain
// itself, pins its head, drops keys whose device left the list, and gives a person with no key left a new first key only from chain evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startSealer } from "./client.js";
import { bindBytes, chainCtx, sha256b64 } from "./wire.js";
import { Presence } from "./proof.js";
import { person, signer, tmp } from "./testing.js";
import { makeGenesis, makeOp, verifyChain, eidOf, b64u } from "../identity/chain.js";

const code = p => p.then(() => null, e => e.code);
const edKey = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32), eid = await eidOf(pub);
  return { eid, pub: b64u(pub), sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: b64u(pub) }) };
};
/** A person's identity: first device D1 and a recovery code key, as ops. Time runs from two days ago so nobody is a newcomer by accident. */
async function identity() {
  const d1 = await edKey(), rc = await edKey(), t0 = Date.now() - 2 * 86_400_000;
  const ops = [await makeGenesis({ kind: "person", entry: d1.entry("device"), code: rc.entry("code"), nonce: "nonce-" + crypto.randomBytes(4).toString("hex"), ts: t0, sign: d1.sign })];
  const id = ops[0].id, add = async (by, body, ts) => { const st = await verifyChain(ops); ops.push(await makeOp(st, body, { by: by.eid, ts, sign: by.sign })); };
  return { id, ops, d1, rc, t0, add };
}
const bind = (who, id, sg) => ({ eid: who.eid, key_id: sg.key_id, sig: b64u(who.sign(bindBytes(id, sg.key_id, sg.enrolment.spki))) });
async function start(t) {
  const dir = tmp("r8"), opts = { dir, timeoutMs: 8000, dev: true, unattested: true };
  const box = { s: startSealer(opts), dir, opts, restart: async () => { await box.s.close(); box.s = startSealer(opts); return box.s; } };
  t.after(async () => { await box.s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return box;
}
const enrolled = async (s, id, sg, existing) => {
  const ch = person(id), e = sg.enrolment, { token } = await s.begin({ chain: ch, person: id, key_id: e.key_id, spki: e.spki });
  const fields = { key_id: e.key_id, spki: crypto.createHash("sha256").update(e.spki).digest("base64url"), signer: e.signer };
  return s.enrol({ chain: ch, person: id, ...e, token, proof: existing ? existing.proof(ch, "presence.enrol", fields) : undefined });
};
const recoverArgs = async (s, id, sg, ops, b) => {
  const e = sg.enrolment, { token } = await s.begin({ chain: person(id), person: id, key_id: e.key_id, spki: e.spki });
  return { chain: person(id), person: id, ops, bind: b, key_id: e.key_id, spki: e.spki, signer: e.signer, token };
};
const reveal = async (s, id, sg) => {
  const ch = person(id), { ref } = await s.api.put({ chain: ch, record: "vyre://spc_testspace0001/contact/c_jane", field: "ssn", class: "us-ssn", value: "123-45-6789" });
  return s.api.reveal({ chain: ch, ref: ref.ref, purpose: "p", proof: sg.proof(ch, "seal.reveal", { ref: ref.ref, purpose: "p" }) });
};

test("R-8: every device lost, the recovery code adds and removes devices on the chain, and the process gives a new first key from that evidence", async t => {
  const box = await start(t), s = box.s, I = await identity(), p1 = signer(I.id);
  await enrolled(s, I.id, p1);
  assert.deepEqual((await s.sync({ chain: person(I.id), person: I.id, ops: I.ops, binds: [bind(I.d1, I.id, p1)] })).pruned, []);
  // The phone is gone. The code (founder, so not a newcomer) adds a new device and removes the old one: the chain says so, and the process drops the key bound to it.
  const d3 = await edKey(); await I.add(I.rc, { type: "add", entry: d3.entry("device") }, I.t0 + 3600_000); await I.add(I.rc, { type: "remove", target: I.d1.eid }, I.t0 + 7200_000);
  const r = await s.sync({ chain: person(I.id), person: I.id, ops: I.ops }); assert.deepEqual(r.pruned, [p1.key_id]);
  assert.equal(await code(reveal(s, I.id, p1)), "unknown_key", "the old device's presence key no longer proves anything");
  const p3 = signer(I.id), a = await recoverArgs(s, I.id, p3, I.ops, bind(d3, I.id, p3));
  const out = await s.recover(a); assert.equal(out.recovered, true); assert.equal(out.event.type, "presence.recovered"); assert.equal(out.event.newcomer_for_ms, 86_400_000);
  assert.equal((await reveal(s, I.id, p3)).value, "123-45-6789", "the recovered key works at once");
  assert.equal((await (await box.restart()).health()).presence, "ok");
});

test("R-8: refusals: no pin, a bare claim, a bind by the wrong key, a stale chain, a barred device, a person who still has keys", async t => {
  const { s } = await start(t), I = await identity(), p1 = signer(I.id), ch = person(I.id);
  await enrolled(s, I.id, p1);
  // Still holds a key: that is an ordinary enrolment, not a recovery.
  const px = signer(I.id); assert.equal(await code(s.recover(await recoverArgs(s, I.id, px, I.ops, bind(I.d1, I.id, px)))), "has_keys");
  // Revoked its last key with no chain ever synced: nothing to check a recovery against.
  assert.equal((await s.revoke({ chain: ch, key_id: p1.key_id, proof: p1.proof(ch, "presence.revoke", { key_id: p1.key_id }) })).revoked, true);
  const p2 = signer(I.id); assert.equal(await code(s.recover(await recoverArgs(s, I.id, p2, I.ops, bind(I.d1, I.id, p2)))), "no_pin");
  // Pin the chain (bound device D1), then the presence key goes away again.
  const q1 = signer(I.id); await enrolled(s, I.id, q1).catch(() => {}); // refused: needs recovery, as before
  assert.equal((await s.sync({ chain: ch, person: I.id, ops: I.ops })).pinned, 0);
  const d2 = await edKey(), stranger = await edKey(); await I.add(I.rc, { type: "add", entry: d2.entry("device") }, I.t0 + 3600_000);
  const p3 = signer(I.id);
  assert.equal(await code(s.recover(await recoverArgs(s, I.id, p3, I.ops, bind(stranger, I.id, p3)))), "bad_bind", "a key the list does not hold cannot vouch");
  const p4 = signer(I.id); assert.equal(await code(s.recover(await recoverArgs(s, I.id, p4, I.ops, bind(d2, I.id, p3)))), "bad_bind", "a bind is for exactly this key");
  assert.equal(await code(s.recover(await recoverArgs(s, I.id, p3, I.ops, bind(I.d1, I.id, p3)))) , null, "D1 was never barred in this run (its key was never bound)");
  // A chain from another person, and a stale replay.
  const J = await identity(); assert.equal(await code(s.sync({ chain: ch, person: I.id, ops: J.ops })), "bad_chain");
  assert.equal(await code(s.sync({ chain: ch, person: I.id, ops: I.ops.slice(0, 1) })), "chain_stale", "an older list than the pin is refused");
});

test("R-8: an old list replayed after a device was removed is stale, and a device whose key was revoked stays barred", async t => {
  const { s } = await start(t), I = await identity(), p1 = signer(I.id), ch = person(I.id);
  await enrolled(s, I.id, p1); await s.sync({ chain: ch, person: I.id, ops: I.ops, binds: [bind(I.d1, I.id, p1)] });
  const old = I.ops.slice(); // D1 still listed
  const d2 = await edKey(); await I.add(I.rc, { type: "add", entry: d2.entry("device") }, I.t0 + 3600_000); await I.add(I.rc, { type: "remove", target: I.d1.eid }, I.t0 + 7200_000);
  await s.sync({ chain: ch, person: I.id, ops: I.ops });
  const p2 = signer(I.id); assert.equal(await code(s.recover(await recoverArgs(s, I.id, p2, old, bind(I.d1, I.id, p2)))), "chain_stale", "the stolen phone cannot come back on an old copy of the list");
  // Barred: revoke a bound key by hand; the same device cannot vouch for a new one while it stays listed.
  const J = await identity(), q1 = signer(J.id), cj = person(J.id);
  await enrolled(s, J.id, q1); await s.sync({ chain: cj, person: J.id, ops: J.ops, binds: [bind(J.d1, J.id, q1)] });
  await s.revoke({ chain: cj, key_id: q1.key_id, proof: q1.proof(cj, "presence.revoke", { key_id: q1.key_id }) });
  const q2 = signer(J.id); assert.equal(await code(s.recover(await recoverArgs(s, J.id, q2, J.ops, bind(J.d1, J.id, q2)))), "bad_bind");
});

test("R-8: a key under 24 hours old removes only newer keys, and an older key removes a newcomer in one tap", async t => {
  const { s } = await start(t), I = await identity(), p1 = signer(I.id), ch = person(I.id);
  await enrolled(s, I.id, p1);
  const p2 = signer(I.id); await enrolled(s, I.id, p2, p1);
  const p3 = signer(I.id); await enrolled(s, I.id, p3, p2);
  assert.equal(await code(s.revoke({ chain: ch, key_id: p1.key_id, proof: p2.proof(ch, "presence.revoke", { key_id: p1.key_id }) })), "newcomer", "a newcomer cannot remove an older key");
  assert.equal(await code(s.revoke({ chain: ch, key_id: p2.key_id, proof: p3.proof(ch, "presence.revoke", { key_id: p2.key_id }) })), "newcomer");
  assert.equal((await s.revoke({ chain: ch, key_id: p3.key_id, proof: p2.proof(ch, "presence.revoke", { key_id: p3.key_id }) })).revoked, true, "a newcomer may remove a newer one");
  assert.equal((await s.revoke({ chain: ch, key_id: p2.key_id, proof: p1.proof(ch, "presence.revoke", { key_id: p2.key_id }) })).revoked, true, "the founder removes a newcomer");
});

test("R-8: a process whose key list was lost recovers each person from the chain, with the pin from the anchor", async t => {
  const box = await start(t), { s, dir } = box, I = await identity(), p1 = signer(I.id), ch = person(I.id);
  await enrolled(s, I.id, p1); await s.sync({ chain: ch, person: I.id, ops: I.ops, binds: [bind(I.d1, I.id, p1)] });
  await s.close(); fs.rmSync(path.join(dir, "presence.json")); const s2 = await box.restart();
  assert.equal((await s2.health()).presence, "recovery");
  const d2 = await edKey(); await I.add(I.rc, { type: "add", entry: d2.entry("device") }, I.t0 + 3600_000);
  const p2 = signer(I.id); assert.equal((await s2.recover(await recoverArgs(s2, I.id, p2, I.ops, bind(d2, I.id, p2)))).recovered, true);
  assert.equal((await s2.health()).presence, "ok");
  assert.equal((await reveal(s2, I.id, p2)).value, "123-45-6789");
  const z = signer("per_zoe"); assert.equal(await code(enrolled(s2, "per_zoe", z)), null, "an unrelated person's first device is still ordinary");
});

test("R-8 item 3: once a chain is pinned every key needs a bind, and a key nobody bound does not outlive its device", async t => {
  const { s } = await start(t), I = await identity(), p1 = signer(I.id), ch = person(I.id);
  await enrolled(s, I.id, p1);
  const p2 = signer(I.id); await enrolled(s, I.id, p2, p1); // before any pin: allowed, but unbound
  assert.deepEqual((await s.sync({ chain: ch, person: I.id, ops: I.ops, binds: [bind(I.d1, I.id, p1)] })).pruned, [p2.key_id], "the unbound key is dropped at the first sync");
  // Pinned now: a further key needs a bind from a listed device.
  const p3 = signer(I.id), e3 = p3.enrolment, f3 = { key_id: e3.key_id, spki: sha256b64(e3.spki), signer: e3.signer };
  const attempt = async b => s.enrol({ chain: ch, person: I.id, ...e3, token: (await s.begin({ chain: ch, person: I.id, key_id: e3.key_id, spki: e3.spki })).token, proof: p1.proof(ch, "presence.enrol", f3), bind: b });
  assert.equal(await code(attempt(undefined)), "needs_bind");
  assert.equal(await code(attempt({ eid: (await edKey()).eid, key_id: e3.key_id, sig: "AAAA" })), "needs_bind", "a device the list does not hold cannot vouch");
  assert.equal((await attempt(bind(I.d1, I.id, p3))).enrolled, true);
  // The device is removed from the chain: both keys it vouched for go, and it is barred.
  const d2 = await edKey(); await I.add(I.rc, { type: "add", entry: d2.entry("device") }, I.t0 + 3600_000); await I.add(I.rc, { type: "remove", target: I.d1.eid }, I.t0 + 7200_000);
  assert.deepEqual((await s.sync({ chain: ch, person: I.id, ops: I.ops })).pruned.sort(), [p1.key_id, p3.key_id].sort());
  const p4 = signer(I.id); assert.equal(await code(s.recover(await recoverArgs(s, I.id, p4, I.ops, bind(I.d1, I.id, p4)))), "bad_bind");
  assert.deepEqual((await s.health()).needs_recovery, [I.id]);
});

test("R-8 item 4: a key saved before the age field existed counts as the oldest, so a newcomer cannot remove it", async t => {
  const dir = tmp("legacy"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = signer("per_alex"), file = path.join(dir, "presence.json");
  const custody = { mac: x => "m" + crypto.createHash("sha256").update(x).digest("hex"), anchorRead: () => ({ v: 1, ever: ["per_alex"] }), anchorWrite: () => {} };
  const body = JSON.stringify({ v: 1, keys: { [legacy.key_id]: { person: "per_alex", signer: "secure_enclave", attested: false, spki: legacy.enrolment.spki } }, ever: ["per_alex"] });
  fs.writeFileSync(file, JSON.stringify({ body, mac: custody.mac(body) }));
  const p = new Presence(Date.now, { allowUnattested: true, file, custody }), ch = person("per_alex"), ctx = chainCtx(ch);
  assert.equal(p.recovery, false); assert.equal(p.keys.get(legacy.key_id).founder, true); assert.equal(p.keys.get(legacy.key_id).since, 0);
  const n = signer("per_alex"), tk = p.begin({ person: "per_alex", key_id: n.key_id, spki: n.enrolment.spki }).token;
  assert.deepEqual(p.enrol({ person: "per_alex", ...n.enrolment, token: tk, proof: legacy.proof(ch, "presence.enrol", { key_id: n.key_id, spki: sha256b64(n.enrolment.spki), signer: n.enrolment.signer }), ctx }), { attested: false });
  assert.equal(p.revoke(legacy.key_id, ctx, n.proof(ch, "presence.revoke", { key_id: legacy.key_id })), "newcomer");
});
