import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as C from "../identity/chain.js";
import { personOfChains } from "./person-of.js";
import { withKernelCall, KERNEL_CALL_TOOL } from "./wink.js";
import { createRemoteServer } from "./server.js";
import { createKernel } from "../index.js";

const H = 3_600_000, T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
async function key(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32), pubText = Buffer.from(pub).toString("base64url"), eid = await C.eidOf(pub);
  return { eid, sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: pubText, label }) };
}
async function identity(first, ts) {
  const g = await C.makeGenesis({ kind: "person", entry: first.entry("device"), nonce: "n-" + first.eid.slice(0, 8), ts, sign: first.sign });
  return { ops: [g], state: await C.verifyChain([g], { now: ts }) };
}
async function step(w, body, k, ts) {
  const op = await C.makeOp(w.state, body, { by: k.eid, ts, sign: k.sign });
  return { ops: [...w.ops, op], state: await C.applyOp(w.state, op, { now: ts }) };
}

test("personOf: a device maps to its person from the identity chain's live list, and a removed device maps to nobody on its very next call", async () => {
  const phone = await key("phone"), mac = await key("mac"), other = await key("other");
  let alex = await identity(phone, T0);
  alex = await step(alex, { type: "add", entry: mac.entry("device") }, phone, T0 + 30 * H);
  const kit = await identity(other, T0);
  const SPACE = "spc_aaaaaaaaaaaa", OWNER = alex.state.id;
  const world = { alex, kit };
  const people = () => [alex.state.id, kit.state.id];
  const personOf = personOfChains({ people, stateOf: async p => (p === alex.state.id ? world.alex.state : p === kit.state.id ? world.kit.state : null) });
  assert.equal(await personOf(phone.eid), alex.state.id);
  assert.equal(await personOf(mac.eid), alex.state.id);
  assert.equal(await personOf(other.eid), kit.state.id);
  assert.equal(await personOf("nobody"), null);
  // through the real server: the mac calls, is removed from the list, and its next call is refused
  let T = 1_800_000_000_000; const clock = () => ++T;
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const server = createRemoteServer({ space: SPACE, kernel: k, clock });
  const serve = withKernelCall(async () => 0, { serverFor: () => server, personOf, pathOf: () => "wink" });
  const call = id => ({ v: 1, space: SPACE, id, ts: clock(), call: "grants.members.list", args: [] });
  assert.equal((await serve(`device:${mac.eid}`, KERNEL_CALL_TOOL, call("rq_1"))).ok, true);
  world.alex = await step(world.alex, { type: "remove", target: mac.eid }, phone, T0 + 40 * H);
  assert.equal(await personOf(mac.eid), null);
  assert.equal((await serve(`device:${mac.eid}`, KERNEL_CALL_TOOL, call("rq_2"))).error.code, "not_a_member");
  assert.equal((await serve(`device:${phone.eid}`, KERNEL_CALL_TOOL, call("rq_3"))).ok, true, "the phone still works");
  // one device on two lists is no one's
  assert.equal(await personOfChains({ people, stateOf: async () => world.alex.state })(phone.eid), null);
});
