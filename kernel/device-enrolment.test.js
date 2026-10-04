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
  assert.equal(await person(await h.chain({ kernelFacts: facts("dev1") })), false, "removed from this Space: no person chain here");
  assert.equal(await person(await h.chainIn(OTHER, { kernelFacts: facts("dev1") })), true, "still works in its other Space");
  removed.add(`${OTHER}|dev1`);
  await assert.rejects(() => h.chainIn(OTHER, { kernelFacts: facts("dev1") }), { code: "not_a_member" });
  assert.equal(await person(await h.chain({ kernelFacts: facts("dev2") })), true, "another device is unaffected");
  const broken = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), deviceEnrolled: async () => { throw new Error("spaces down"); } });
  const hb = broken.kernelFor({ name: "probe", needs: { kernel: { actions: [] } } });
  assert.equal(await person(await hb.chain({ kernelFacts: facts("dev1") })), false, "an error is a no");
  assert.equal(await person(await hb.chain({ kernelFacts: { kind: "socket", surface: "cli", uid: 501, pid: 1, inside_model_process: false } })), true, "a local surface has no device to remove");
});
