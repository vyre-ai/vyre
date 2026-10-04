import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteKernel } from "./client.js";
import { createRemoteServer } from "./server.js";
import { createMemoryTransport } from "./memory-transport.js";
import { createKernel } from "../index.js";
import { payloadHash } from "../seal/wire.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
let T = 1_800_000_000_000;
const clock = () => ++T;

/** A home with the sealing process's contract (a proof over exactly the payload hash, once) and a remote client over an in-memory wire as the owner's device. */
async function rig({ signer } = {}) {
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, SPACE, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "wrong_payload") };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), clock, presence });
  const server = createRemoteServer({ space: SPACE, home: "home_x", kernel: k, clock });
  const transport = createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: "dev_owner", person: OWNER, path: "wink" } });
  const device = createRemoteKernel({ space: SPACE, transport, clock, ...(signer ? { signer } : {}) });
  return { k, server, transport, device };
}
const role = { person: BOB, role: "member" };

test("presence over the wire: with no proof the home answers needs_presence with its challenge; the device signs it and the same call goes through", async () => {
  /** the device's presence key: signs the challenge's payload hash with a fresh nonce */
  const signer = async ch => { return { presence: { payload_hash: ch.payload_hash, nonce: "n_" + Math.random() } }; };
  const { device, k } = await rig({ signer });
  await device.gateway.grants.setRole({}, role);
  assert.equal(await k.gateway.members.roleOf({ kind: "person", id: BOB, space: SPACE }), "member");
});

test("the challenge names the call, the space, this home and a one-use nonce, and the peer session alone is not presence", async () => {
  const { device } = await rig();
  const e = await device.gateway.grants.setRole({}, role).then(() => null, x => x);
  assert.ok(e && /presence/.test(e.code), `needs presence: ${e && e.code}`);
  const ch = e.challenge;
  assert.equal(ch.call, "grants.setRole"); assert.equal(ch.space, SPACE); assert.equal(ch.home, "home_x");
  assert.match(ch.nonce, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(ch.op, "grant.role"); assert.ok(ch.payload_hash);
});

test("a proof is refused with no nonce, another call's nonce, a used nonce and an expired one; the nonce is spent even when the kernel refuses", async () => {
  const { device } = await rig();
  const ask = async (...args) => (await device.gateway.grants.setRole({}, ...args).then(() => null, x => x)).challenge;
  const good = hash => ({ payload_hash: hash, nonce: "p" + Math.random() });
  const ch = await ask(role);
  const other = await ask({ person: "per_carol", role: "member" });
  assert.equal((await device.call("grants.setRole", [role, { presence: good(ch.payload_hash), challenge: other.nonce }]).then(() => null, e => e)).code, "bad_challenge", "another call's nonce");
  assert.equal((await device.call("grants.setRole", [role, { presence: good(ch.payload_hash), challenge: "nope" }]).then(() => null, e => e)).code, "bad_challenge", "a nonce this home never issued");
  const fresh = await ask(role);
  const wrong = await device.call("grants.setRole", [role, { presence: good("wrong"), challenge: fresh.nonce }]).then(() => null, e => e);
  assert.ok(wrong && wrong.code !== "bad_challenge", "the kernel's verifier refuses a wrong hash");
  assert.equal((await device.call("grants.setRole", [role, { presence: good(fresh.payload_hash), challenge: fresh.nonce }]).then(() => null, e => e)).code, "bad_challenge", "the nonce was spent by the refused try");
  const late = await ask(role);
  T += 3 * 60 * 1000;
  assert.equal((await device.call("grants.setRole", [role, { presence: good(late.payload_hash), challenge: late.nonce }]).then(() => null, e => e)).code, "bad_challenge", "an expired nonce");
});

test("a caller's own options object keeps its other options beside the proof", async () => {
  const { device, transport } = await rig();
  const ch = await (async () => (await device.call("grants.setRole", [role]).then(() => null, e => e)).challenge)();
  await device.call("grants.setRole", [role, { presence: { payload_hash: ch.payload_hash, nonce: "o1" }, challenge: ch.nonce, reason: "x" }]).catch(() => null);
  const sent = transport.sent[transport.sent.length - 1];
  assert.deepEqual(sent.args, [role, { reason: "x" }]);
  assert.equal(sent.opts, 1);
  assert.equal(sent.proof.nonce, "o1");
});

test("another device cannot use a challenge issued to the owner's device", async () => {
  const { server, device } = await rig();
  const ch = (await device.gateway.grants.setRole({}, role).then(() => null, x => x)).challenge;
  const t2 = createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: "dev_other", person: OWNER, path: "wink" } });
  const d2 = createRemoteKernel({ space: SPACE, transport: t2, clock });
  const r = await d2.call("grants.setRole", [role, { presence: { payload_hash: ch.payload_hash, nonce: "x" }, challenge: ch.nonce }]).then(() => null, e => e);
  assert.equal(r.code, "bad_challenge");
});
