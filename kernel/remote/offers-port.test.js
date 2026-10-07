import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createOffersPort } from "./offers-port.js";
import { proofRequest, proofFrom } from "./proof.js";
import { createKernel } from "../index.js";
import { payloadHash } from "../seal/wire.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
let T = 1_800_000_000_000;
const clock = () => ++T;

async function rig() {
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, SPACE, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), clock, presence });
  const owner = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  await k.gateway.grants.setRole(owner, { person: BOB, role: "member" }, proofFrom({ kernel_proof: { payload_hash: proofRequest(SPACE, "setRole", { person: BOB, role: "member" }).payload_hash, nonce: Math.random().toString(36) } }));
  const handle = { space: SPACE, grants: k.gateway.grants, chain: async () => owner, proofFrom };
  /** The meta a surface sends for the offer call the port will make. */
  const meta = (call, ...a) => ({ kernel_proof: { payload_hash: proofRequest(SPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) } });
  return { port: createOffersPort(handle), meta, g: k.gateway.grants };
}

test("offers port: get is false until the space allows, set space on/off goes through grants.offers with the caller's proof", async () => {
  const { port, meta, g } = await rig();
  const x = { member: BOB, device_key: "key-1" };
  assert.deepEqual(await port.get(SPACE, "dev1", x), { space_allows: false, member_accepts: false });
  await port.set(SPACE, "dev1", "space", true, { ...x, meta: meta("offer", { side: "space_allows", member: BOB, device: "dev1" }) });
  assert.deepEqual(await port.get(SPACE, "dev1", x), { space_allows: true, member_accepts: false });
  assert.equal(g.offers.active({ member: BOB, device: "dev1" }).spaceAllows, true);
  // Setting it again is a no-op and needs no new proof.
  await port.set(SPACE, "dev1", "space", true, { ...x, meta: {} });
  const id = g.offers.find({ side: "space_allows", member: BOB, device: "dev1" }).id;
  await port.set(SPACE, "dev1", "space", false, { ...x, meta: meta("unoffer", id) });
  assert.deepEqual(await port.get(SPACE, "dev1", x), { space_allows: false, member_accepts: false });
});

test("offers port: no proof means no offer, a missing member is refused, the owner cannot accept for the member", async () => {
  const { port, meta } = await rig();
  const x = { member: BOB, device_key: "key-1" };
  await assert.rejects(port.set(SPACE, "dev1", "space", true, { ...x, meta: {} }), e => ["needs_presence", "not_allowed", "denied"].includes(e.code));
  await assert.rejects(port.set(SPACE, "dev1", "space", true, { meta: {} }), e => e.code === "bad_input");
  await assert.rejects(port.set(SPACE, "dev1", "member", true, { ...x, meta: meta("offer", { side: "member_accepts", member: BOB, device: "dev1", device_key: "key-1" }) }), e => e.code === "not_allowed");
  assert.deepEqual(await port.get("spc_bbbbbbbbbbbb", "dev1", x).catch(e => e.code), "unavailable");
});

test("offers port: the member's own side takes the member from the proven caller, never from an argument", async () => {
  const { port, meta } = await rig();
  // the rig's caller is the owner: naming BOB as the member for the member side is refused, and omitting the member uses the caller
  await assert.rejects(() => port.set(SPACE, "dev1", "member", true, { member: BOB, device_key: "key-1", meta: meta("offer", { side: "member_accepts", member: BOB, device: "dev1", device_key: "key-1" }) }), e => e.code === "not_allowed");
  await assert.rejects(() => port.set(SPACE, "dev1", "member", true, { device_key: "key-1", meta: {} }), e => e.code === "needs_presence" || e.code === "not_allowed" || e.code === "denied");
});
