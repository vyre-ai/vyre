// @ts-check
// Design B, the admission check (core/relay/chain-admit.js): a device the identity chain lists may be admitted for a person already a member here, proven by a signature from that device's chain key over
// "vyre-chain-hello-v1". Every refusal below is a case rc1-d asked for.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createChainAdmit, chainHelloMessage, CHAIN_HELLO_TAG } from "./chain-admit.js";

const IDENT = "per_" + "a".repeat(26), OTHER = "per_" + "b".repeat(26), BOX = "BOXKEY".repeat(8), CH = "c".repeat(16);
const T0 = 1_700_000_000_000, DAY = 86_400_000;

const key = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); return { pub: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url"), sign: (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey).toString("base64url") }; };
const EID = (/** @type {string} */ c) => c.repeat(26);

/** A harness: one identity whose chain lists the devices given; the directory is a function the test can break. */
function rig(/** @type {{ entries?: any[], seq?: number, head?: string, role?: string | null, now?: () => number }} */ o = {}) {
  const k = key();
  const entry = { eid: EID("d"), kind: "device", pub: k.pub, since: T0 - 3 * DAY, addedBy: EID("o"), founder: false };
  const state = { id: IDENT, kind: "person", seq: o.seq ?? 5, head: o.head ?? "h5", ts: T0, entries: o.entries ?? [entry] };
  const r = { clock: T0, state: /** @type {any} */ (state), reachable: true, fetches: 0, role: o.role === undefined ? "owner" : o.role };
  const admit = createChainAdmit({
    boxId: async () => BOX, now: () => r.clock,
    roleOf: (/** @type {string} */ id) => (id === IDENT ? r.role : null),
    fetchState: async (/** @type {string} */ id) => { r.fetches++; if (!r.reachable) throw Object.assign(new Error("down"), { code: "unreachable" }); if (id !== IDENT) return null; return r.state; },
  });
  const hello = (/** @type {Record<string, any>} */ over = {}) => {
    const h = { identity: IDENT, entry: EID("d"), ts: r.clock, nonce: crypto.randomBytes(16).toString("base64url"), channel: CH, ...over };
    return { ...h, sig: over.sig ?? k.sign(chainHelloMessage(BOX, h)) };
  };
  return { r, admit, hello, k, entry };
}

test("the hello message names the box, the identity, the entry, the time, the nonce and the channel, under its own tag", () => {
  const m = chainHelloMessage("bx", { identity: "i", entry: "e", ts: 1, nonce: "n", channel: "c" }).toString();
  assert.equal(CHAIN_HELLO_TAG, "vyre-chain-hello-v1");
  assert.equal(m, "vyre-chain-hello-v1\nbx\ni\ne\n1\nn\nc");
});

test("a chain-listed device of the owner is admitted, with the person's role and the chain position it was admitted at", async () => {
  const { admit, hello } = rig();
  const a = await admit.check(hello(), CH);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.identity, a.entry, a.role, a.limited, a.seq], [IDENT, EID("d"), "owner", false, 5]);
});

test("a member's device is admitted at the member's role only; an unknown identity is refused with the same words as a bad signature", async () => {
  const m = rig({ role: "member" });
  assert.equal((await m.admit.check(m.hello(), CH)).role, "member");
  const u = rig({ role: null });
  const unknown = await u.admit.check(u.hello(), CH);
  const bad = await rig().admit.check({ ...rig().hello(), sig: "x".repeat(86) }, CH);
  assert.deepEqual([unknown.ok, unknown.why], [false, "bad_proof"]);
  assert.deepEqual([bad.ok, bad.why], [false, "bad_proof"], "the same refusal, so a probe cannot tell who is a member");
});

test("a hello replayed at another server, on another channel, or after the window is refused", async () => {
  const a = rig();
  const h = a.hello();
  assert.equal((await a.admit.check(h, CH)).ok, true);
  assert.equal((await a.admit.check(h, CH)).why, "replayed", "the same hello twice");
  const other = rig();
  const h2 = other.hello();
  const elsewhere = createChainAdmit({ boxId: async () => "ANOTHERBOX".repeat(4), now: () => T0, roleOf: () => "owner", fetchState: async () => other.r.state });
  assert.equal((await elsewhere.check(h2, CH)).why, "bad_proof", "another server's box id changes the message, so the signature fails");
  assert.equal((await other.admit.check(other.hello(), "d".repeat(16))).why, "wrong_channel", "carried onto another channel");
  const late = rig();
  const h3 = late.hello();
  late.r.clock = T0 + 3 * 60_000;
  assert.equal((await late.admit.check(h3, CH)).why, "stale");
});

test("a device not on the chain, a removed one, or a signature by another key is refused", async () => {
  const a = rig();
  assert.equal((await a.admit.check(a.hello({ entry: EID("z") }), CH)).why, "bad_proof", "no such entry");
  const thief = key();
  const h = { identity: IDENT, entry: EID("d"), ts: T0, nonce: "n".repeat(20), channel: CH };
  assert.equal((await a.admit.check({ ...h, sig: thief.sign(chainHelloMessage(BOX, h)) }, CH)).why, "bad_proof");
  const gone = rig({ entries: [] });
  assert.equal((await gone.admit.check(gone.hello(), CH)).why, "bad_proof");
});

test("a newcomer under 24 hours, and a relay-held device, are admitted but marked limited", async () => {
  const k = key();
  const young = { eid: EID("d"), kind: "device", pub: k.pub, since: T0 - 3_600_000, addedBy: EID("o"), founder: false };
  const y = rig({ entries: [young] });
  const hy = { identity: IDENT, entry: EID("d"), ts: T0, nonce: "y".repeat(20), channel: CH };
  const ay = await y.admit.check({ ...hy, sig: k.sign(chainHelloMessage(BOX, hy)) }, CH);
  assert.deepEqual([ay.ok, ay.limited], [true, true]);
  const held = rig();
  held.r.state.entries[0] = { ...held.r.state.entries[0], held: "relay" };
  const ah = await held.admit.check(held.hello(), CH);
  assert.deepEqual([ah.ok, ah.limited], [true, true]);
});

test("the chain is verified by the server: a lower seq, or the same seq with another head (a fork), is refused", async () => {
  const a = rig();
  assert.equal((await a.admit.check(a.hello(), CH)).ok, true);
  a.r.clock += 6 * 60_000; // past the refresh time, so the chain is fetched again
  a.r.state = { ...a.r.state, seq: 4, head: "h4" };
  assert.equal((await a.admit.check(a.hello(), "c".repeat(16))).why, "chain_older");
  a.r.state = { ...a.r.state, seq: 5, head: "other" };
  assert.equal((await a.admit.check(a.hello(), "c".repeat(16))).why, "chain_fork");
  a.r.state = { ...a.r.state, seq: 6, head: "h6" };
  assert.equal((await a.admit.check(a.hello(), "c".repeat(16))).ok, true, "a higher seq moves the chain forward");
});

test("the chain is fetched at most every 5 minutes", async () => {
  const a = rig();
  await a.admit.check(a.hello(), CH);
  await a.admit.check(a.hello(), CH);
  assert.equal(a.r.fetches, 1);
  a.r.clock += 5 * 60_000 + 1;
  await a.admit.check(a.hello(), CH);
  assert.equal(a.r.fetches, 2);
});

test("an unreachable directory: a device already admitted keeps working for an hour, a new one is refused, and after the hour none", async () => {
  const a = rig();
  assert.equal((await a.admit.check(a.hello(), CH)).ok, true);
  a.r.reachable = false;
  a.r.clock += 10 * 60_000;
  const again = await a.admit.check(a.hello(), CH);
  assert.deepEqual([again.ok, again.stale], [true, true], "a device that was admitted is still admitted inside the hour");
  const fresh = key();
  a.r.state.entries.push({ eid: EID("n"), kind: "device", pub: fresh.pub, since: T0 - 5 * DAY, addedBy: EID("o"), founder: false });
  const hn = { identity: IDENT, entry: EID("n"), ts: a.r.clock, nonce: "q".repeat(20), channel: CH };
  const fresher = await a.admit.check({ ...hn, sig: fresh.sign(chainHelloMessage(BOX, hn)) }, CH);
  assert.deepEqual([fresher.ok, fresher.why], [false, "cannot_check"], "a device never admitted before is refused while the chain cannot be checked");
  a.r.clock += 61 * 60_000;
  assert.equal((await a.admit.check(a.hello(), CH)).why, "cannot_check", "after the hour, none");
});

test("still-listed: a removed chain device is found within the refresh time", async () => {
  const a = rig();
  assert.equal(await a.admit.stillListed(IDENT, EID("d")), "ok");
  a.r.state = { ...a.r.state, seq: 6, head: "h6", entries: [] };
  assert.equal(await a.admit.stillListed(IDENT, EID("d")), "ok", "inside 5 minutes the earlier answer stands");
  a.r.clock += 5 * 60_000 + 1;
  assert.equal(await a.admit.stillListed(IDENT, EID("d")), "gone");
});

test("a malformed hello is refused before anything is fetched", async () => {
  const a = rig();
  for (const bad of [null, "x", {}, { ...a.hello(), identity: "not-an-id" }, { ...a.hello(), entry: "short" }, { ...a.hello(), nonce: "short" }, { ...a.hello(), ts: "now" }]) {
    assert.equal((await a.admit.check(/** @type {any} */ (bad), CH)).why, "bad_input");
  }
  assert.equal(a.r.fetches, 0);
});
