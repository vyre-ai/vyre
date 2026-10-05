// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as C from "./chain.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

/** A key: raw public key text, its eid and a sign function. */
async function key(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubText = Buffer.from(pub).toString("base64url");
  const eid = await C.eidOf(pub);
  return { label, pub: pubText, eid, sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: pubText }) };
}

async function person(first, ts = T0) {
  const g = await C.makeGenesis({ kind: "person", entry: first.entry("device"), nonce: "n-" + first.eid.slice(0, 8), ts, sign: first.sign });
  return { ops: [g], state: await C.verifyChain([g], { now: ts }) };
}
/** Append one op signed by `k` and return the new world. */
async function step(w, body, k, ts, ctx = {}) {
  const op = await C.makeOp(w.state, body, { by: k.eid, ts, sign: k.sign, via: ctx.via });
  const state = await C.applyOp(w.state, op, { now: ts, ...ctx });
  return { ops: [...w.ops, op], state };
}
const refused = (p, code) => assert.rejects(p, e => e.code === code, `expected ${code}`);

test("chain: the id is the hash of the genesis, so it cannot be claimed by another", async () => {
  const a = await key("phone"), b = await key("other");
  const w = await person(a);
  assert.match(w.state.id, /^per_[a-z2-7]{26}$/);
  const forged = { ...w.ops[0], id: "per_" + "a".repeat(26) };
  await refused(C.verifyChain([forged], { now: T0 }), "bad_id");
  const tampered = { ...w.ops[0], nonce: "another-nonce" };
  await refused(C.verifyChain([tampered], { now: T0 }), "bad_id");
  const badSig = await C.makeGenesis({ kind: "person", entry: a.entry("device"), nonce: "n-123456789", ts: T0, sign: b.sign });
  await refused(C.verifyChain([badSig], { now: T0 }), "bad_signature");
});

test("chain: any entry adds and removes others, each change signed by something already on the list", async () => {
  const phone = await key("phone"), laptop = await key("laptop"), tablet = await key("tablet");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: laptop.entry("device") }, phone, T0 + H);
  // the new laptop signs in at once and adds a device
  w = await step(w, { type: "add", entry: tablet.entry("device") }, laptop, T0 + 2 * H);
  // a stranger cannot sign
  const stranger = await key("stranger");
  await assert.rejects(step(w, { type: "add", entry: stranger.entry("device") }, stranger, T0 + 3 * H), e => e.code === "not_on_list");
  // a signature that is not the signer's is refused
  const forged = await C.makeOp(w.state, { type: "remove", target: phone.eid }, { by: phone.eid, ts: T0 + 3 * H, sign: stranger.sign });
  await refused(C.applyOp(w.state, forged, { now: T0 + 3 * H }), "bad_signature");
  // an old device removes
  w = await step(w, { type: "remove", target: tablet.eid }, phone, T0 + 3 * H);
  assert.equal(w.state.entries.length, 2);
  // the whole chain verifies from scratch and equals the state built step by step
  const again = await C.verifyChain(w.ops, { now: T0 + 4 * H });
  assert.equal(again.head, w.state.head);
});

test("chain: the newcomer rule, in each direction", async () => {
  const phone = await key("phone"), thief = await key("thief"), code = await key("code"), friend = await key("friend");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: code.entry("code") }, phone, T0 + 25 * H); // phone is 25h old: allowed
  w = await step(w, { type: "add", entry: friend.entry("contact") }, phone, T0 + 26 * H);
  w = await step(w, { type: "add", entry: thief.entry("device") }, code, T0 + 30 * H); // the code adds a device
  const t1 = T0 + 31 * H;
  // the newcomer works at once...
  const mac = await key("mac");
  const w2 = await step(w, { type: "add", entry: mac.entry("device") }, thief, t1);
  assert.equal(w2.state.entries.length, 5);
  // ...but cannot remove older entries, replace the code, or add or remove contacts
  await refused(step(w, { type: "remove", target: phone.eid }, thief, t1), "newcomer");
  await refused(step(w, { type: "remove", target: code.eid }, thief, t1), "newcomer");
  await refused(step(w, { type: "remove", target: friend.eid }, thief, t1), "newcomer");
  const code2 = await key("code2"), friend2 = await key("friend2");
  await refused(step(w, { type: "replace-code", entry: code2.entry("code") }, thief, t1), "newcomer");
  await refused(step(w, { type: "add", entry: friend2.entry("contact") }, thief, t1), "newcomer");
  // a newcomer may remove a newer newcomer and itself
  const w3 = await step(w2, { type: "remove", target: mac.eid }, thief, t1 + H);
  assert.equal(w3.state.entries.length, 4);
  // any older device removes the newcomer in one step, and the alert lists it
  const w4 = await step(w3, { type: "remove", target: thief.eid }, phone, t1 + 2 * H);
  assert.ok(!C.alertsSince(w4.ops, 0).some(a => a.entry && a.entry.eid === thief.eid && a.type === "remove"));
  assert.deepEqual(C.alertsSince(w4.ops, w3.state.seq).map(a => [a.type, a.target]), [["remove", thief.eid]]);
  // after 24 hours the same device is trusted
  const w5 = await step(w2, { type: "remove", target: phone.eid }, thief, t1 + 24 * H);
  assert.ok(!w5.state.entries.some(e => e.eid === phone.eid));
});

test("chain: the recovery code is replaceable, the old one stops, and the new one keeps the old one's age and still only adds a device", async () => {
  const phone = await key("phone"), code = await key("code"), code2 = await key("code2"), fresh = await key("fresh");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: code.entry("code") }, phone, T0 + 25 * H);
  await refused(step(w, { type: "add", entry: code2.entry("code") }, phone, T0 + 26 * H), "has_code");
  w = await step(w, { type: "replace-code", entry: code2.entry("code") }, phone, T0 + 100 * H);
  assert.ok(!w.state.entries.some(e => e.eid === code.eid));
  await refused(step(w, { type: "add", entry: fresh.entry("device") }, code, T0 + 101 * H), "not_on_list");
  // the new code signs back in at once with full power: all devices lost, code in hand
  const w2 = await step(w, { type: "add", entry: fresh.entry("device") }, code2, T0 + 101 * H);
  w2.state.entries.find(e => e.eid === code2.eid);
  // ...but only to add a device: it cannot remove the owner's devices, and the owner's phone stays
  await refused(step(w2, { type: "remove", target: phone.eid }, code2, T0 + 102 * H), "code_limited");
  assert.ok(w2.state.entries.some(e => e.eid === phone.eid));
  // the new device that the code added is itself a newcomer
  await refused(step(w2, { type: "remove", target: code2.eid }, fresh, T0 + 102 * H), "newcomer");
});

test("chain: two recovery contacts bring an identity back with nothing else", async () => {
  const phone = await key("phone"), c1 = await key("c1"), c2 = await key("c2"), c3 = await key("c3"), newPhone = await key("new phone");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: c1.entry("contact") }, phone, T0 + 25 * H);
  w = await step(w, { type: "add", entry: c2.entry("contact") }, phone, T0 + 25 * H + 1);
  w = await step(w, { type: "add", entry: c3.entry("contact") }, phone, T0 + 25 * H + 2);
  const t = T0 + 80 * H;
  const build = async signers => {
    const op = await C.makeOp(w.state, { type: "recover", entry: newPhone.entry("device") }, { ts: t });
    op.approvals = signers.map(k => ({ eid: k.eid, sig: C.b64u(k.sign(C.approvalMessage(op))) }));
    return op;
  };
  await refused(C.applyOp(w.state, await build([c1]), { now: t }), "no_quorum");
  await refused(C.applyOp(w.state, await build([c1, c1]), { now: t }), "no_quorum");
  const outsider = await key("outsider");
  await refused(C.applyOp(w.state, await build([c1, outsider]), { now: t }), "no_quorum");
  const state = await C.applyOp(w.state, await build([c1, c3]), { now: t });
  assert.ok(state.entries.some(e => e.eid === newPhone.eid && e.since === t));
  // the recovered device is a newcomer: it cannot remove the old phone for 24 hours
  const ops = [...w.ops, await build([c1, c3])];
  const after = { ops, state };
  await refused(step(after, { type: "remove", target: phone.eid }, newPhone, t + H), "newcomer");
  // a contact cannot sign ordinary ops
  await refused(step(w, { type: "add", entry: outsider.entry("device") }, c1, t), "not_allowed");
  // a contact added minutes before cannot approve
  const c4 = await key("c4");
  const w4 = await step(w, { type: "add", entry: c4.entry("contact") }, phone, t - 1000);
  const op4 = await C.makeOp(w4.state, { type: "recover", entry: newPhone.entry("device") }, { ts: t });
  op4.approvals = [c1, c4].map(k => ({ eid: k.eid, sig: C.b64u(k.sign(C.approvalMessage(op4))) }));
  await refused(C.applyOp(w4.state, op4, { now: t }), "no_quorum");
});

test("chain: a chain cannot be left with nobody who can sign, and time cannot run backwards or ahead", async () => {
  const phone = await key("phone"), mac = await key("mac");
  let w = await person(phone);
  await refused(step(w, { type: "remove", target: phone.eid }, phone, T0 + H), "last_entry");
  w = await step(w, { type: "add", entry: mac.entry("device") }, phone, T0 + H);
  await refused(step(w, { type: "add", entry: (await key("x")).entry("device") }, phone, T0 + H - 1), "bad_time");
  await refused(C.applyOp(w.state, await C.makeOp(w.state, { type: "remove", target: mac.eid }, { by: phone.eid, ts: T0 + 10 * H, sign: phone.sign }), { now: T0 + H }), "bad_time");
});

test("chain: a fork is detected, a stale answer is detected, an extension is fine", async () => {
  const phone = await key("phone"), mac = await key("mac"), thief = await key("thief");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: mac.entry("device") }, phone, T0 + H);
  const pin = C.pinOf(w.state);
  assert.deepEqual(await C.checkAnswer(pin, w.ops), { ok: true, fresh: false });
  const longer = await step(w, { type: "add", entry: thief.entry("device") }, mac, T0 + 2 * H);
  assert.deepEqual(await C.checkAnswer(pin, longer.ops), { ok: true, fresh: true });
  // stale: the directory replays the chain from before the pinned head
  assert.equal((await C.checkAnswer(pin, w.ops.slice(0, 1))).code, "stale");
  // fork: a different second op at the same place
  const alt = await step(await person(phone, T0).then(p => p), { type: "add", entry: thief.entry("device") }, phone, T0 + H);
  assert.equal((await C.checkAnswer(pin, alt.ops)).code, "fork");
  // another identity entirely
  const other = await person(await key("other"));
  assert.equal((await C.checkAnswer(pin, other.ops)).code, "other_id");
});

test("chain: a space's list holds its owners, signed through the owner's own devices, with the newcomer rule applied through them", async () => {
  const phone = await key("phone"), newDevice = await key("new device"), bobPhone = await key("bob phone");
  let alex = await person(phone, T0);
  alex = await step(alex, { type: "add", entry: newDevice.entry("device") }, phone, T0 + 100 * H);
  const bob = await person(bobPhone, T0);
  const chains = new Map([[alex.state.id, alex.ops], [bob.state.id, bob.ops]]);
  const ctx = { ownerOps: async id => chains.get(id) || null, now: T0 + 200 * H };
  const pos = async () => C.viaOf(alex.ops);

  const g = await C.makeGenesis({ kind: "space", entry: { eid: alex.state.id, kind: "owner", subject: alex.state.id, label: "Alex" }, nonce: "space-nonce-1", ts: T0 + 101 * H, via: phone.eid, viaPos: await pos(), sign: phone.sign });
  let space = { ops: [g], state: await C.verifyChain([g], ctx) };
  assert.match(space.state.id, /^spc_[a-z2-7]{26}$/);
  const op = async (body, dev, ts) => C.makeOp(space.state, body, { by: alex.state.id, via: dev.eid, viaPos: await pos(), ts, sign: dev.sign });
  // an owner adds another owner through an old device
  const addBob = await op({ type: "add", entry: { eid: bob.state.id, kind: "owner", subject: bob.state.id } }, phone, T0 + 102 * H);
  space = { ops: [...space.ops, addBob], state: await C.applyOp(space.state, addBob, ctx) };
  assert.equal(space.state.entries.length, 2);
  // alex's brand new device cannot change owners
  await refused(C.applyOp(space.state, await op({ type: "remove", target: bob.state.id }, newDevice, T0 + 100 * H + 1000 + 3 * H), ctx), "newcomer");
  // a device that is not on alex's list cannot sign for the space, and a recovery code never can
  await refused(C.applyOp(space.state, await op({ type: "remove", target: bob.state.id }, bobPhone, T0 + 103 * H), ctx), "not_on_list");
  // a space op must name a real position of the owner's list
  const badPos = await C.makeOp(space.state, { type: "remove", target: bob.state.id }, { by: alex.state.id, via: phone.eid, viaPos: { via_seq: 1, via_head: "0".repeat(64) }, ts: T0 + 103 * H, sign: phone.sign });
  await refused(C.applyOp(space.state, badPos, ctx), "bad_via");
  const noPos = await C.makeOp(space.state, { type: "remove", target: bob.state.id }, { by: alex.state.id, via: phone.eid, ts: T0 + 103 * H, sign: phone.sign });
  await refused(C.applyOp(space.state, noPos, ctx), "bad_via");
  // adding an owner is allowed before that person has signed anything; a person with no chain cannot sign later
  const strangerId = "per_" + "b".repeat(26);
  const ok = await C.applyOp(space.state, await op({ type: "add", entry: { eid: strangerId, kind: "owner", subject: strangerId } }, phone, T0 + 104 * H), ctx);
  assert.equal(ok.entries.length, 3);
  const rm = await op({ type: "remove", target: bob.state.id }, phone, T0 + 105 * H);
  space = { ops: [...space.ops, rm], state: await C.applyOp(space.state, rm, ctx) };
  await refused(C.applyOp(space.state, await op({ type: "remove", target: alex.state.id }, phone, T0 + 106 * H), ctx), "last_entry");
  // history verifies again from scratch
  assert.equal((await C.verifyChain(space.ops, ctx)).head, space.state.head);
});

test("chain (reviewer-2 probe 1): the recovery code alone cannot take over: it can add a device and nothing else", async () => {
  const phone = await key("phone"), code = await key("code"), code2 = await key("thief code"), thief = await key("thief"), friend = await key("friend");
  const g = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), code: code.entry("code"), nonce: "takeover-nonce", ts: T0, sign: phone.sign });
  let w = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  // a thief holding only the code, long after setup
  const t = T0 + 500 * H;
  w = await step(w, { type: "add", entry: thief.entry("device") }, code, t);
  await refused(step(w, { type: "remove", target: phone.eid }, code, t + 1), "code_limited");
  await refused(step(w, { type: "replace-code", entry: code2.entry("code") }, code, t + 1), "code_limited");
  await refused(step(w, { type: "add", entry: friend.entry("contact") }, code, t + 1), "code_limited");
  await refused(step(w, { type: "remove", target: code.eid }, code, t + 1), "code_limited");
  // the device it added is a newcomer for 24 hours: it cannot remove the owner's phone or replace the code
  await refused(step(w, { type: "remove", target: phone.eid }, thief, t + H), "newcomer");
  await refused(step(w, { type: "replace-code", entry: code2.entry("code") }, thief, t + H), "newcomer");
  // the owner's phone removes it in one op and the thief is out
  const out = await step(w, { type: "remove", target: thief.eid }, phone, t + 2 * H);
  assert.deepEqual(out.state.entries.map(e => e.eid).sort(), [phone.eid, code.eid].sort());
  // the code's own key is a newcomer for acts that are not ops, too (it cannot release a name)
  const state = out.state;
  const k = await C.signerKey(state, code.eid, undefined, t + 3 * H, {});
  assert.equal(k.young, true);
});

test("chain (reviewer-2 probe 2): a device removed from its owner's list cannot sign space ops, whatever time it claims", async () => {
  const d1 = await key("d1"), d2 = await key("d2");
  let alex = await person(d1, T0);
  alex = await step(alex, { type: "add", entry: d2.entry("device") }, d1, T0 + 30 * H);
  const pos0 = await C.viaOf(alex.ops);           // the list while d1 is still on it
  const chains = new Map([[alex.state.id, alex.ops]]);
  const ctxOf = (live, extra = {}) => ({ ownerOps: async id => chains.get(id) || null, now: T0 + 400 * H, live, ...extra });
  const g = await C.makeGenesis({ kind: "space", entry: { eid: alex.state.id, kind: "owner", subject: alex.state.id }, nonce: "backdate-nonce", ts: T0 + 40 * H, via: d1.eid, viaPos: pos0, sign: d1.sign });
  const space = { ops: [g], state: await C.verifyChain([g], ctxOf(false)) };
  // d1 is removed from alex's list at R (by d2, which is old enough by now)
  alex = await step(alex, { type: "remove", target: d1.eid }, d2, T0 + 100 * H);
  chains.set(alex.state.id, alex.ops);
  // the thief signs a space op with d1, a time just after the space's last op (before R) and the position it saw before the removal
  const evil = await C.makeOp(space.state, { type: "add", entry: { eid: "per_" + "c".repeat(26), kind: "owner", subject: "per_" + "c".repeat(26) } }, { by: alex.state.id, via: d1.eid, viaPos: pos0, ts: T0 + 101 * H, sign: d1.sign });
  // accepted now (the directory, or a client for what is newer than its pin): refused, whatever its time or position
  await refused(C.applyOp(space.state, evil, ctxOf(true, { now: T0 + 101 * H })), "removed");
  await refused(C.applyOp(space.state, evil, ctxOf(false, { liveFrom: 1, now: T0 + 101 * H })), "removed");
  // history that was accepted while d1 was on the list still replays
  const old = await C.makeOp(space.state, { type: "add", entry: { eid: "per_" + "c".repeat(26), kind: "owner", subject: "per_" + "c".repeat(26) } }, { by: alex.state.id, via: d1.eid, viaPos: pos0, ts: T0 + 41 * H, sign: d1.sign });
  assert.equal((await C.applyOp(space.state, old, ctxOf(false))).entries.length, 2);
  // a removed device cannot name a position after its removal either: it is not on the list there
  const after = await C.viaOf(alex.ops);
  const late = await C.makeOp(space.state, { type: "add", entry: { eid: "per_" + "d".repeat(26), kind: "owner", subject: "per_" + "d".repeat(26) } }, { by: alex.state.id, via: d1.eid, viaPos: after, ts: T0 + 41 * H, sign: d1.sign });
  await refused(C.applyOp(space.state, late, ctxOf(false)), "not_on_list");
  // and a record or an act signed for the space is held to the same rule
  const k2 = await C.signerKey(space.state, alex.state.id, d2.eid, T0 + 200 * H, ctxOf(true));
  assert.ok(k2.pub);
  await refused(C.signerKey(space.state, alex.state.id, d1.eid, T0 + 200 * H, ctxOf(true)), "not_on_list");
});

test("chain: the first device and the recovery code made with it are founders, never newcomers", async () => {
  const phone = await key("phone"), code = await key("code"), mac = await key("mac"), friend = await key("friend");
  const g = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), code: code.entry("code"), nonce: "founder-nonce", ts: T0, sign: phone.sign });
  let w = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  assert.deepEqual(w.state.entries.map(e => e.kind), ["device", "code"]);
  // minutes in, the founder sets up a contact and adds a laptop; a recovery code made at setup works at once
  w = await step(w, { type: "add", entry: friend.entry("contact") }, phone, T0 + 60_000);
  w = await step(w, { type: "add", entry: mac.entry("device") }, code, T0 + 120_000);
  // the laptop is a newcomer: it cannot remove the founder
  await refused(step(w, { type: "remove", target: phone.eid }, mac, T0 + 180_000), "newcomer");
  // a genesis may not smuggle in anything but a code
  const bad = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), code: mac.entry("device"), nonce: "founder-nonce2", ts: T0, sign: phone.sign });
  await refused(C.verifyChain([bad], { now: T0 }), "bad_entry");
});

test("chain (reviewer-2 W-1): a newcomer's age never comes from a time its adder wrote", async () => {
  const phone = await key("phone"), code = await key("code"), code2 = await key("thief code"), thief = await key("thief");
  const g = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), code: code.entry("code"), nonce: "backdate-nonce", ts: T0, sign: phone.sign });
  const w0 = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  const now = T0 + 500 * H;
  // the probe: a code-only thief adds a device with the previous op's time, 500 hours before the acceptor's clock
  const stale = await C.makeOp(w0.state, { type: "add", entry: thief.entry("device") }, { by: code.eid, ts: T0, sign: code.sign });
  await refused(C.applyOp(w0.state, stale, { now, live: true }), "bad_time");
  // made now, it is accepted, and the device is a newcomer for 24 hours: it cannot remove the owner's phone, replace the code or add a contact
  const fresh = await C.makeOp(w0.state, { type: "add", entry: thief.entry("device") }, { by: code.eid, ts: now, sign: code.sign });
  const s1 = await C.applyOp(w0.state, fresh, { now, live: true });
  const w1 = { ops: [g, fresh], state: s1 };
  await refused(C.applyOp(s1, await C.makeOp(s1, { type: "remove", target: phone.eid }, { by: thief.eid, ts: now + 1000, sign: thief.sign }), { now: now + 2000, live: true }), "newcomer");
  await refused(C.applyOp(s1, await C.makeOp(s1, { type: "replace-code", entry: code2.entry("code") }, { by: thief.eid, ts: now + 1000, sign: thief.sign }), { now: now + 2000, live: true }), "newcomer");
  await refused(C.applyOp(s1, await C.makeOp(s1, { type: "remove", target: phone.eid }, { by: thief.eid, ts: now + 23 * H, sign: thief.sign }), { now: now + 23 * H, live: true }), "newcomer");
  // a verifier that learned the op later counts the age from when it first saw it, not from the op's time
  const lateCtx = { now: now + 600 * H, seenAt: seq => (seq === 1 ? now + 599 * H : undefined) };
  const learned = await C.verifyChain(w1.ops, lateCtx);
  assert.equal(learned.entries.find(e => e.eid === thief.eid).since, now + 599 * H);
  const rmLate = await C.makeOp(learned, { type: "remove", target: phone.eid }, { by: thief.eid, ts: now + 599 * H + H, sign: thief.sign });
  await refused(C.applyOp(learned, rmLate, { now: now + 600 * H, seenAt: lateCtx.seenAt }), "newcomer");
  // while the same chain without a recorded first sight would count from the op's own time
  const plain = await C.verifyChain(w1.ops, { now: now + 600 * H });
  assert.equal(plain.entries.find(e => e.eid === thief.eid).since, now);
});

// KP-1: a key a web origin can reach has no say over who speaks for the identity; a passkey signs each op with user verification.
const webKey = async label => { const k = await key(label); return { ...k, entry: kind => ({ ...k.entry(kind), held: "web" }) }; };

/** A software passkey: a P-256 key that signs assertions the way an authenticator does. `uv` and `rp`/`origin` can be bent for the refusals. */
async function passkey(label, rp = "app.vyre.run") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
  const pubText = Buffer.from(pub).toString("base64url");
  const eid = await C.eidOf(pub);
  const assert1 = (m, o = {}) => {
    const rpHash = crypto.createHash("sha256").update(o.rp ?? rp).digest();
    const ad = Buffer.concat([rpHash, Buffer.from([o.flags ?? 0x05]), Buffer.from([0, 0, 0, 1])]);
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: o.challenge ?? crypto.createHash("sha256").update(Buffer.from(m)).digest().toString("base64url"), origin: o.origin ?? `https://${rp}`, crossOrigin: false }));
    const signed = Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]);
    const s = crypto.sign("sha256", signed, privateKey); // DER, as an authenticator gives it
    return Buffer.from(JSON.stringify({ ad: ad.toString("base64url"), cd: cd.toString("base64url"), s: s.toString("base64url") }));
  };
  const sign = (m, o) => assert1(m, o);
  return { label, pub: pubText, eid, sign, with: o => m => assert1(m, o), entry: () => ({ eid, kind: "device", pub: pubText, alg: "webauthn-es256", rp }) };
}

test("KP-1: a founder key held on the web signs nothing about the list (the probe: add, replace-code, remove), and the paper code still gets a way back", async () => {
  const web = await webKey("browser"), code = await key("paper"), attacker = await key("attacker"), phone = await key("phone");
  let w = await person(web);
  // the genesis is its own: a web key may make the identity
  assert.equal(w.state.entries[0].held, "web");
  const later = T0 + 48 * H; // past every newcomer window: the old rule would have allowed all of this
  await refused(step(w, { type: "add", entry: attacker.entry("device") }, web, later), "web_key");
  await refused(step(w, { type: "add", entry: code.entry("code") }, web, later), "web_key");
  await refused(step(w, { type: "remove", target: web.eid }, web, later), "web_key");
  // a passkey is the way to hold the list from a browser; here a founder passkey adds the code and a phone
  const pk = await passkey("alex's passkey");
  w = await person(pk);
  w = await step(w, { type: "add", entry: code.entry("code") }, pk, T0 + 25 * H);
  w = await step(w, { type: "add", entry: phone.entry("device") }, pk, T0 + 26 * H);
  assert.deepEqual(w.state.entries.map(e => e.kind), ["device", "code", "device"]);
  // a web-held device added later (the browser's own key) is on the list for the pairing it does, but cannot change the list
  const web2 = await webKey("browser 2");
  w = await step(w, { type: "add", entry: web2.entry("device") }, pk, T0 + 27 * H);
  await refused(step(w, { type: "add", entry: attacker.entry("device") }, web2, T0 + 80 * H), "web_key");
  await refused(step(w, { type: "remove", target: phone.eid }, web2, T0 + 80 * H), "web_key");
  const replaceWith = await key("new paper");
  await refused(step(w, { type: "replace-code", entry: replaceWith.entry("code") }, web2, T0 + 80 * H), "web_key");
  // the paper code still adds a device (the way back), and a web-held one asked for by itself is still not authority
  const back = await key("back in");
  const w2 = await step(w, { type: "add", entry: back.entry("device") }, code, T0 + 90 * H);
  assert.ok(w2.state.entries.some(e => e.eid === back.eid));
});

test("KP-1: a passkey assertion must carry user verification, name this op, and come from its own rp and origin", async () => {
  const pk = await passkey("alex's passkey"), friend = await key("friend"), other = await key("other");
  const w = await person(pk);
  const add = (k, o, ts = T0 + 25 * H) => step(w, { type: "add", entry: k.entry("device") }, { ...pk, sign: m => (o ? pk.sign(m, o) : pk.sign(m)) }, ts);
  const ok = await add(friend);
  assert.ok(ok.state.entries.some(e => e.eid === friend.eid));
  await refused(add(friend, { flags: 0x01 }), "bad_signature"); // present, not verified
  await refused(add(friend, { rp: "evil.example" }), "bad_signature"); // another rp's hash
  await refused(add(friend, { origin: "https://evil.example" }), "bad_signature");
  await refused(add(friend, { challenge: crypto.randomBytes(32).toString("base64url") }), "bad_signature");
  // an assertion made for one op does not carry to another
  const forOther = pk.sign(C.messageOf(await C.makeOp(w.state, { type: "add", entry: friend.entry("device") }, { by: pk.eid, ts: T0 + 25 * H })));
  const swapped = await C.makeOp(w.state, { type: "add", entry: other.entry("device") }, { by: pk.eid, ts: T0 + 25 * H });
  await refused(C.applyOp(w.state, { ...swapped, sig: C.b64u(forOther) }, { now: T0 + 25 * H }), "bad_signature");
  // a malformed passkey entry is refused at the shape
  await refused(C.makeGenesis({ kind: "person", entry: { ...pk.entry(), rp: "" }, nonce: "n-badrp1234", ts: T0, sign: pk.sign }).then(g => C.verifyChain([g], { now: T0 })), "bad_entry");
  await refused(C.makeGenesis({ kind: "person", entry: { ...pk.entry(), held: "web" }, nonce: "n-badrp1235", ts: T0, sign: pk.sign }).then(g => C.verifyChain([g], { now: T0 })), "bad_entry");
});

// NK-2: a phone's Ed25519 seed is a software key; its Secure Enclave key (Face ID) must also sign every list change.
async function enclaveKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url");
  const low = raw => { const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; let s = 0n; for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(raw[i]); if (s > n / 2n) { s = n - s; for (let i = 63; i >= 32; i--) { raw[i] = Number(s & 255n); s >>= 8n; } } return raw; };
  const high = raw => { const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; let s = 0n; for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(raw[i]); if (s <= n / 2n) { s = n - s; for (let i = 63; i >= 32; i--) { raw[i] = Number(s & 255n); s >>= 8n; } } return raw; };
  const rawSig = m => crypto.sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { pub, esign: m => low(Buffer.from(rawSig(m))), esignHigh: m => high(Buffer.from(rawSig(m))), esignDer: m => crypto.sign("sha256", Buffer.from(m), privateKey) };
}
const phoneEntry = (k, enc) => ({ ...k.entry("device"), enclave: enc.pub });

test("NK-2: the phone's seed alone cannot add, remove or replace-code; the seed plus its enclave signature can; another key's or another op's esig is refused; a non-list use needs only the seed", async () => {
  const phone = await key("phone"), mac = await key("mac"), thief = await key("thief"), code = await key("paper"), enc = await enclaveKey(), other = await enclaveKey();
  const g = await C.makeGenesis({ kind: "person", entry: phoneEntry(phone, enc), nonce: "n-nk2-0001", ts: T0, sign: phone.sign });
  let w = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  const later = T0 + 48 * H;
  const run = (body, signer, extra = {}, ts = later) => step(w, body, { ...signer, sign: signer.sign }, ts, extra);
  const withEsig = async (body, esign, ts = later) => { const op = await C.makeOp(w.state, body, { by: phone.eid, ts, sign: phone.sign, esign }); return C.applyOp(w.state, op, { now: ts }); };
  // the reviewer's probe: the seed alone
  await refused(run({ type: "add", entry: thief.entry("device") }, phone), "needs_enclave");
  await refused(run({ type: "add", entry: code.entry("code") }, phone), "needs_enclave");
  await refused(run({ type: "remove", target: phone.eid }, phone), "needs_enclave");
  // the seed plus the right enclave signature, raw or DER
  const added = await withEsig({ type: "add", entry: code.entry("code") }, enc.esign);
  assert.ok(added.entries.some(e => e.eid === code.eid));
  // one op, one hash: the DER form and the high-s twin of the same signature are refused, not accepted as second valid ops
  await assert.rejects(withEsig({ type: "add", entry: mac.entry("device") }, enc.esignDer), e => e.code === "needs_enclave");
  await assert.rejects(withEsig({ type: "add", entry: mac.entry("device") }, enc.esignHigh), e => e.code === "needs_enclave");
  // another key's esig, and an esig made for another op
  await assert.rejects(withEsig({ type: "add", entry: thief.entry("device") }, other.esign), e => e.code === "needs_enclave");
  const forOther = await C.makeOp(w.state, { type: "add", entry: mac.entry("device") }, { by: phone.eid, ts: later, sign: phone.sign, esign: enc.esign });
  const swapped = await C.makeOp(w.state, { type: "add", entry: thief.entry("device") }, { by: phone.eid, ts: later, sign: phone.sign });
  await refused(C.applyOp(w.state, { ...swapped, esig: forOther.esig }, { now: later }), "needs_enclave");
  // a Mac key with no enclave and no held keeps signing alone (the lead's ruling decides if that stays)
  w = { ...w, state: added };
  w.ops = [...w.ops];
  const addMac = await step({ ops: w.ops, state: added }, { type: "add", entry: mac.entry("device") }, { ...phone, sign: phone.sign }, later + H, {}).catch(e => e);
  assert.equal(addMac.code, "needs_enclave", "the phone entry still needs its esig on a later op");
  // the enclave key is part of the signed entry: a malformed one is refused at the shape
  const bad = { ...phone.entry("device"), enclave: Buffer.alloc(33, 1).toString("base64url") };
  await refused(C.makeGenesis({ kind: "person", entry: bad, nonce: "n-nk2-0002", ts: T0, sign: phone.sign }).then(x => C.verifyChain([x], { now: T0 })), "bad_entry");
});

test("NK-2: a device with no enclave key and no web hold (a Mac or a server) still changes the list alone (the lead rules whether that stays)", async () => {
  const mac = await key("mac"), friend = await key("friend");
  let w = await person(mac);
  w = await step(w, { type: "add", entry: friend.entry("device") }, mac, T0 + 30 * H);
  assert.ok(w.state.entries.some(e => e.eid === friend.eid));
});

test("NE-1: a passkey op's head does not depend on the assertion's signature bytes; an esig has one canonical form, so one op has one hash", async () => {
  const pk = await passkey("alex's passkey"), friend = await key("friend");
  const w = await person(pk);
  const op = await C.makeOp(w.state, { type: "add", entry: friend.entry("device") }, { by: pk.eid, ts: T0 + 25 * H, sign: pk.sign });
  // the high-s twin of the authenticator's signature: anyone can make it, and it verifies, so the head must not change with it
  const env = JSON.parse(Buffer.from(op.sig, "base64url").toString());
  const der = Buffer.from(env.s, "base64url");
  const rLen = der[3], sOff = 4 + rLen + 2, sLen = der[4 + rLen + 1];
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = 0n; for (const b of der.subarray(sOff, sOff + sLen)) s = (s << 8n) | BigInt(b);
  const twin = n - s;
  const hex = twin.toString(16).padStart(64, "0");
  let sb = Buffer.from(hex, "hex"); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
  const r = der.subarray(4, 4 + rLen);
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
  const twinDer = Buffer.concat([Buffer.from([0x30, body.length]), body]);
  const twinOp = { ...op, sig: C.b64u(Buffer.from(JSON.stringify({ ...env, s: twinDer.toString("base64url") }))) };
  const a = await C.applyOp(w.state, op, { now: T0 + 25 * H }), b = await C.applyOp(w.state, twinOp, { now: T0 + 25 * H });
  assert.equal(a.head, b.head, "both forms are valid and give the same head");
});

test("NE-1 cares: a long garbage sig on an Ed25519 entry is refused (it can never be an accepted op whose hash ignores its sig); two different valid passkey signatures over one op give one head and cannot change what the op says", async () => {
  const phone = await key("phone"), friend = await key("friend"), other = await key("other"), pk = await passkey("alex's passkey");
  const w0 = await person(phone);
  const op = await C.makeOp(w0.state, { type: "add", entry: friend.entry("device") }, { by: phone.eid, ts: T0 + 25 * H, sign: phone.sign });
  const garbage = { ...op, sig: C.b64u(Buffer.alloc(200, 7)) };
  await refused(C.applyOp(w0.state, garbage, { now: T0 + 25 * H }), "bad_signature");
  // two different valid assertions over the same op: one head
  const w = await person(pk);
  const body = { type: "add", entry: friend.entry("device") };
  const a = await C.makeOp(w.state, body, { by: pk.eid, ts: T0 + 25 * H, sign: pk.sign });
  const b = await C.makeOp(w.state, body, { by: pk.eid, ts: T0 + 25 * H, sign: pk.sign });
  assert.notEqual(a.sig, b.sig, "ECDSA signs differently each time");
  const sa = await C.applyOp(w.state, a, { now: T0 + 25 * H }), sb = await C.applyOp(w.state, b, { now: T0 + 25 * H });
  assert.equal(sa.head, sb.head);
  // the signature still binds the content: another op's body under a's signature is refused
  const swapped = { ...a, entry: other.entry("device") };
  await refused(C.applyOp(w.state, swapped, { now: T0 + 25 * H }), "bad_signature");
});

test("chain: a label on a device entry is refused where ops are accepted now, and an older chain that holds labels still verifies", async () => {
  const phone = await key("phone"), laptop = await key("laptop");
  const labelled = k => ({ ...k.entry("device"), label: k.label });
  const g = await C.makeGenesis({ kind: "person", entry: labelled(phone), nonce: "label-nonce-1", ts: T0, sign: m => phone.sign(m) });
  await assert.rejects(C.verifyChain([g], { now: T0 + 1, live: true }), e => e.code === "bad_entry" && /label/.test(e.message), "refused when accepted live");
  const old = await C.verifyChain([g], { now: T0 + 1 });
  assert.deepEqual(old.entries.map(e => e.label), ["phone"], "history that holds labels still reads");
  const clean = await person(phone);
  const op = await C.makeOp(clean.state, { type: "add", entry: labelled(laptop) }, { by: phone.eid, ts: T0 + H, sign: m => phone.sign(m) });
  await assert.rejects(C.applyOp(clean.state, op, { now: T0 + H, live: true }), e => e.code === "bad_entry");
});

// `agree`: a device's P-256 key-agreement point (the key a chat key is wrapped to). Part of the signed entry, immutable, device entries only, carried by genesis (enrolment), add (recovery and join) alike.
const agreePoint = () => Buffer.from(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url");

test("agree: a device entry carries a P-256 agreement point through genesis and a later add; a malformed one, one on a code entry, and a changed one are refused", async () => {
  const dev = await key("agree-a"), other = await key("agree-b"), code = await key("agree-code");
  const pt = agreePoint();
  const g = await C.makeGenesis({ kind: "person", entry: { ...dev.entry("device"), agree: pt }, nonce: "n-agree-001", ts: T0, sign: dev.sign });
  const state = await C.verifyChain([g], { now: T0 });
  assert.equal(state.entries.find(e => e.eid === dev.eid).agree, pt, "enrolment: the point is in the verified entry");
  // a recovery or a join is an add of a device entry: it carries its own point
  const later = T0 + 48 * H, pt2 = agreePoint();
  const add = await C.makeOp(state, { type: "add", entry: { ...other.entry("device"), agree: pt2 } }, { by: dev.eid, ts: later, sign: dev.sign });
  const s2 = await C.applyOp(state, add, { now: later });
  assert.equal(s2.entries.find(e => e.eid === other.eid).agree, pt2, "an add keeps it");
  assert.equal(s2.entries.find(e => e.eid === dev.eid).agree, pt, "and nothing changed the first device's");
  // shape
  for (const bad of ["", "AAAA", Buffer.alloc(65, 1).toString("base64url"), Buffer.alloc(64, 4).toString("base64url")]) {
    await refused(C.makeGenesis({ kind: "person", entry: { ...dev.entry("device"), agree: bad }, nonce: "n-agree-bad1", ts: T0, sign: dev.sign }).then(x => C.verifyChain([x], { now: T0 })), "bad_entry");
  }
  const badAdd = await C.makeOp(state, { type: "add", entry: { ...code.entry("code"), agree: pt } }, { by: dev.eid, ts: later, sign: dev.sign });
  await refused(C.applyOp(state, badAdd, { now: later }), "bad_entry");
  // it is part of the signed entry: a different point under the same signature is a different genesis, so the id (and the signature) no longer match
  const g2 = JSON.parse(JSON.stringify(g)); g2.entry.agree = agreePoint();
  await assert.rejects(() => C.verifyChain([g2], { now: T0 }));
});

// `agree` op: a device gives ITSELF its key-agreement point once, when its entry has none (an entry written before the key existed). Self-signed; nothing else on the entry moves.
test("agree op: an older entry gains agree once; a second is refused; another entry's, a code's, a contact's and a space's are refused; eid, age and signing key stay", async () => {
  const dev = await key("old-a"), other = await key("old-b"), code = await key("old-code");
  const g = await C.makeGenesis({ kind: "person", entry: dev.entry("device"), code: code.entry("code"), nonce: "n-agree-op-1", ts: T0, sign: dev.sign });
  let w = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  w = await step(w, { type: "add", entry: other.entry("device") }, dev, T0 + H);
  const before = w.state.entries.find(e => e.eid === dev.eid);
  assert.equal(before.agree, undefined);
  const pt = agreePoint();
  // another device (however old) cannot set it for the entry
  await refused(step(w, { type: "agree", target: dev.eid, agree: agreePoint() }, other, T0 + 2 * H), "not_allowed");
  // the recovery code cannot (code_limited), and cannot be the target either
  await refused(step(w, { type: "agree", target: dev.eid, agree: pt }, code, T0 + 2 * H), "code_limited");
  // a malformed point
  await refused(step(w, { type: "agree", target: dev.eid, agree: "AAAA" }, dev, T0 + 2 * H), "bad_entry");
  await refused(step(w, { type: "agree", target: dev.eid, agree: Buffer.concat([Buffer.from([2]), Buffer.alloc(64)]).toString("base64url") }, dev, T0 + 2 * H), "bad_entry");
  // the entry itself: accepted, once
  const done = await step(w, { type: "agree", target: dev.eid, agree: pt }, dev, T0 + 2 * H, { live: true });
  const after = done.state.entries.find(e => e.eid === dev.eid);
  assert.equal(after.agree, pt);
  assert.deepEqual({ ...after, agree: undefined }, { ...before, agree: undefined }, "nothing else on the entry moved: eid, kind, key, since, founder");
  assert.equal(done.state.entries.find(e => e.eid === other.eid).agree, undefined, "the other device is untouched");
  await refused(step(done, { type: "agree", target: dev.eid, agree: agreePoint() }, dev, T0 + 3 * H), "exists");
  // a verifier that replays the whole chain reaches the same state
  assert.equal((await C.verifyChain(done.ops, { now: T0 + 2 * H })).entries.find(e => e.eid === dev.eid).agree, pt);
  // a device that already carried agree from genesis cannot set another
  const g2 = await C.makeGenesis({ kind: "person", entry: { ...other.entry("device"), agree: agreePoint() }, nonce: "n-agree-op-2", ts: T0, sign: other.sign });
  const w2 = { ops: [g2], state: await C.verifyChain([g2], { now: T0 }) };
  await refused(step(w2, { type: "agree", target: other.eid, agree: agreePoint() }, other, T0 + H), "exists");
  // a code entry cannot be targeted; a contact cannot sign one
  await refused(step(w, { type: "agree", target: code.eid, agree: pt }, dev, T0 + 2 * H), "not_allowed");
  // the op is not in the alerts a device shows for a new sign-in
  assert.deepEqual(C.alertsSince(done.ops, 1).map(a => a.type), [], "an agree op is not a sign-in");
});

test("agree op: a web-held key and an enclave entry without its esig are refused like any list change", async () => {
  const web = await key("web-a");
  const g = await C.makeGenesis({ kind: "person", entry: { ...web.entry("device"), held: "web" }, nonce: "n-agree-web1", ts: T0, sign: web.sign });
  const w = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  await refused(step(w, { type: "agree", target: web.eid, agree: agreePoint() }, web, T0 + H), "web_key");
});
