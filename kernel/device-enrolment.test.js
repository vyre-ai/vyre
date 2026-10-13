import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";

const SPACE = "spc_aaaaaaaaaaaa", OTHER = "spc_bbbbbbbbbbbb", OWNER = "per_alex";
const facts = id => ({ kind: "device", device_key_id: id, person: OWNER, path: "direct" });

test("a device removed from a Space has no person chain in it, and keeps its chains in the Spaces it is still in", async () => {
  const removed = new Set();      // `space|device`
  const asked = [];
  const deviceEnrolled = async (space, device) => { asked.push([space, device]); return !removed.has(`${space}|${device}`); };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), deviceEnrolled });
  const other = await createKernel({ space: OTHER, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8) });
  k.bindSpaces({ hosted: id => (id === OTHER ? { space: OTHER, kernel: other, gateway: other.gateway, surfaces: other.surfaces } : null), for: () => null });
  const h = k.kernelFor({ name: "probe", needs: { kernel: { actions: [] } } });
  const person = async (c) => c.hops[0].actor.kind === "person" && c.hops.length === 1;
  assert.equal(await person(await h.chain({ kernelFacts: facts("dev1") })), true, "enrolled: the person's chain");
  assert.equal(await person(await h.chainIn(OTHER, { kernelFacts: facts("dev1") })), true, "enrolled in the other Space too");
  removed.add(`${SPACE}|dev1`);
  await assert.rejects(() => h.chain({ kernelFacts: facts("dev1") }), { code: "not_a_member", message: /no longer part of this Space/ }, "removed from this Space: refused, never the module's service chain");
  const svc = await h.chain({});
  assert.deepEqual(svc.hops.map(x => x.actor.kind), ["service"], "a plain module service call (no device claim) still gets the module's own chain");
  assert.deepEqual((await h.chain({ kernelFacts: { kind: "module", module: "probe", first_party: true } })).hops.map(x => x.actor.kind), ["service"], "a non-device fact is not a device claim");
  assert.equal(await person(await h.chainIn(OTHER, { kernelFacts: facts("dev1") })), true, "still works in its other Space");
  removed.add(`${OTHER}|dev1`);
  await assert.rejects(() => h.chainIn(OTHER, { kernelFacts: facts("dev1") }), { code: "not_a_member" });
  assert.equal(await person(await h.chain({ kernelFacts: facts("dev2") })), true, "another device is unaffected");
  // a removed device cannot reach a reach-anyone tool's Space data: there is no chain to hand records.list
  const rec = async c => k.gateway.records.query(c, "note", { page: { limit: 1 } });
  await assert.rejects(async () => rec(await h.chain({ kernelFacts: facts("dev1") })), { code: "not_a_member" });
  const broken = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), deviceEnrolled: async () => { throw new Error("spaces down"); } });
  const hb = broken.kernelFor({ name: "probe", needs: { kernel: { actions: [] } } });
  await assert.rejects(() => hb.chain({ kernelFacts: facts("dev1") }), { code: "not_a_member" }, "an error is a no");
  assert.equal(await person(await hb.chain({ kernelFacts: { kind: "socket", surface: "cli", uid: 501, pid: 1, inside_model_process: false } })), true, "a local surface has no device to remove");
});

test("a session opened in the home speaks for its person, and its agent, in another Space they belong to; a Space it does not host, and a token it did not sign, give nothing", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
  const other = await createKernel({ space: OTHER, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8) });
  k.bindSpaces({ hosted: id => (id === OTHER ? { space: OTHER, kernel: other, gateway: other.gateway, surfaces: other.surfaces } : null), for: () => null });
  const h = k.kernelFor({ name: "probe", needs: { kernel: { actions: [] } } });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "dev1", person: OWNER, path: "direct" });
  const s = await k.surfaces.open(owner, { agent: "assistant", ttl_ms: 60_000 });
  const c = await h.chainIn(OTHER, { token: s.token });
  assert.equal(c.space, OTHER);
  assert.deepEqual(c.hops.map(x => [x.actor.kind, x.actor.id]), [["person", OWNER], ["agent", "assistant"]], "the person and the agent the token names, in that Space");
  await assert.rejects(() => h.chainIn("spc_cccccccccccc", { token: s.token }), { code: "not_found" }, "a Space this home does not host has no chain");
  await assert.rejects(() => h.chainIn(OTHER, { token: "not-a-token" }), { code: "not_a_member" });
});
