// @ts-check
// The relay's key on a person's list (GitHub sign-in, rc.4): it may only add a device marked `via: "github"`; that device is limited until a full device confirms it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as C from "./chain.js";
import * as OLD from "../../test/fixtures/chain-before-relay.js";

const H = 3_600_000, D = 24 * H;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
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
async function step(w, body, k, ts, ctx = {}) {
  const op = await C.makeOp(w.state, body, { by: k.eid, ts, sign: k.sign, via: ctx.via });
  return { ops: [...w.ops, op], state: await C.applyOp(w.state, op, { now: ts, ...ctx }) };
}
const refused = (p, code) => assert.rejects(p, e => e.code === code, `expected ${code}`);
const relayEntry = k => ({ ...k.entry("device"), held: "relay" });
const github = k => ({ ...k.entry("device"), via: "github" });

/** A person with a phone, and the relay's key put on the list a day and a bit later. */
async function world() {
  const phone = await key("phone"), relay = await key("relay");
  let w = await person(phone);
  w = await step(w, { type: "add", entry: relayEntry(relay) }, phone, T0 + 25 * H);
  return { phone, relay, w, t: T0 + 26 * H };
}

test("the relay's key adds a device marked via github, and that device is limited", async () => {
  const { relay, w, t, phone } = await world();
  const laptop = await key("new laptop");
  const w2 = await step(w, { type: "add", entry: github(laptop) }, relay, t);
  const e = w2.state.entries.find(x => x.eid === laptop.eid);
  assert.equal(e.via, "github");
  assert.equal(e.confirmed, undefined);
  // limited: it changes nothing on the list, however old
  const other = await key("other");
  const later = t + 5 * D;
  await refused(step(w2, { type: "add", entry: other.entry("device") }, laptop, later), "limited");
  await refused(step(w2, { type: "remove", target: phone.eid }, laptop, later), "limited");
  await refused(step(w2, { type: "confirm", target: laptop.eid }, laptop, later), "limited");
  // a full device confirms it, then it is ordinary
  const w3 = await step(w2, { type: "confirm", target: laptop.eid }, phone, later);
  assert.equal(w3.state.entries.find(x => x.eid === laptop.eid).confirmed, true);
  const w4 = await step(w3, { type: "add", entry: other.entry("device") }, laptop, later + H);
  assert.ok(w4.state.entries.find(x => x.eid === other.eid));
});

test("the relay's key can do nothing but that one add: not remove, replace-code, a code, a contact, a plain device, a web key, itself or confirm", async () => {
  const { relay, w, t, phone } = await world();
  const x = await key("x"), code = await key("code"), rel2 = await key("relay2");
  const later = t + 5 * D;
  await refused(step(w, { type: "remove", target: phone.eid }, relay, later), "relay_limited");
  await refused(step(w, { type: "replace-code", entry: code.entry("code") }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: code.entry("code") }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: x.entry("contact") }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: x.entry("device") }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: { ...x.entry("device"), held: "web", via: "github" } }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: { ...relayEntry(rel2), via: "github" } }, relay, later), "relay_limited");
  await refused(step(w, { type: "add", entry: relayEntry(rel2) }, relay, later), "relay_limited");
  await refused(step(w, { type: "confirm", target: relay.eid }, relay, later), "relay_limited");
});

test("only a full device a day old puts the relay's key on the list, and only the relay's key adds via github", async () => {
  const phone = await key("phone"), relay = await key("relay"), x = await key("x");
  const w = await person(phone);
  const w1 = await step(w, { type: "add", entry: x.entry("device") }, phone, T0 + 25 * H);
  await refused(step(w1, { type: "add", entry: relayEntry(relay) }, x, T0 + 26 * H), "not_allowed"); // x is under a day old
  const y = await key("y");
  await refused(step(w1, { type: "add", entry: github(y) }, phone, T0 + 26 * H), "not_allowed"); // not the relay
  await refused(step(w1, { type: "add", entry: github(y) }, x, T0 + 60 * H), "not_allowed");
  const w2 = await step(w1, { type: "add", entry: relayEntry(relay) }, phone, T0 + 26 * H);
  await refused(step(w2, { type: "add", entry: { ...relayEntry(y) } }, relay, T0 + 60 * H), "relay_limited");
  // a held:relay entry that is not a device, or a via on a code, is not an entry
  await refused(step(w1, { type: "add", entry: { ...y.entry("code"), held: "relay" } }, phone, T0 + 26 * H), "bad_entry");
  await refused(step(w1, { type: "add", entry: { ...y.entry("code"), via: "github" } }, phone, T0 + 26 * H), "bad_entry");
});

test("the relay's key adds at most three devices a day, and its adds are refused after 90 days without a full device's signature", async () => {
  const { relay, w, t, phone } = await world();
  let cur = w;
  for (let i = 0; i < 3; i++) cur = await step(cur, { type: "add", entry: github(await key("d" + i)) }, relay, t + i * H);
  await refused(step(cur, { type: "add", entry: github(await key("d4")) }, relay, t + 4 * H), "relay_rate");
  cur = await step(cur, { type: "add", entry: github(await key("d5")) }, relay, t + D + 3 * H); // a day later
  // 90 days with no full-device signature
  const lonely = await world();
  await refused(step(lonely.w, { type: "add", entry: github(await key("late")) }, lonely.relay, lonely.t + 91 * D), "relay_expired");
  // a full device's op refreshes it
  const w2 = await step(lonely.w, { type: "add", entry: (await key("tablet")).entry("device") }, lonely.phone, lonely.t + 80 * D);
  const ok = await step(w2, { type: "add", entry: github(await key("later")) }, lonely.relay, lonely.t + 150 * D);
  assert.ok(ok.state.entries.length > 3);
  void phone;
});

test("a limited device cannot be a space owner's signing device; the recovery code confirms; a removed relay key adds nothing", async () => {
  const { relay, w, t, phone } = await world();
  const laptop = await key("laptop"), code = await key("code");
  let w2 = await step(w, { type: "add", entry: code.entry("code") }, phone, t);
  w2 = await step(w2, { type: "add", entry: github(laptop) }, relay, t + H);
  const wc = await step(w2, { type: "confirm", target: laptop.eid }, code, t + 2 * H);
  assert.equal(wc.state.entries.find(x => x.eid === laptop.eid).confirmed, true);
  const gone = await step(w2, { type: "remove", target: relay.eid }, phone, t + 2 * H);
  await refused(step(gone, { type: "add", entry: github(await key("again")) }, relay, t + 3 * H), "not_on_list");
  // the relay's key does not count as someone who can sign when the last real device would go
  const solo = await person(phone);
  const s2 = await step(solo, { type: "add", entry: relayEntry(relay) }, phone, T0 + 25 * H);
  await refused(step(s2, { type: "remove", target: phone.eid }, phone, T0 + 26 * H), "last_entry");
  // a space refuses a limited device as its owner's signer
  const owner = await C.makeGenesis({ kind: "space", entry: { eid: w2.state.id, kind: "owner", subject: w2.state.id }, nonce: "nonce-space-1", ts: t + 3 * H, via: laptop.eid,
    viaPos: await C.viaOf(w2.ops), sign: laptop.sign });
  await assert.rejects(C.verifyChain([owner], { now: t + 3 * H, ownerOps: async () => w2.ops }), e => e.code === "limited");
});

test("an older verifier refuses a chain that holds the relay's key, so the key is never passed off there as a full device", async () => {
  const { w, t, relay } = await world();
  await assert.rejects(OLD.verifyChain(w.ops, { now: t }), e => e.code === "bad_entry", "the older rule does not know held relay");
  // and what it does know is unchanged: the same chain without the relay entry verifies on both
  const p = await key("p");
  const plain = await person(p);
  assert.equal((await OLD.verifyChain(plain.ops, { now: T0 })).head, (await C.verifyChain(plain.ops, { now: T0 })).head);
  void relay;
});
