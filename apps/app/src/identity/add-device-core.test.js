import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { addDeviceCore, nameOfPairing } from "./add-device-core.js";

const KEY = { publicKey: "pub", eid: "eid_me" };
const PAIRED = { enrolled: true, relay: "ws://r", route: "rt", box: "bx", device: "dev", name: "Awbox.vyre.run", identity: { id: "per_x", vyre: "Harlow.vyre.run" } };

function stubs(over = {}) {
  const saved = [], kept = [];
  const d = {
    held: async () => false, makeKey: async () => KEY,
    pair: async (o) => { o.onAck?.("WINK-AAAA-BBBB"); return PAIRED; },
    readList: async () => ({ ops: [{ n: 1 }], id: "per_x", eids: ["eid_other", "eid_me"], pin: { seq: 1 } }),
    save: async (i) => { saved.push(i); }, keepPairing: async (p) => { kept.push(p); },
    ...over,
  };
  return { d, saved, kept };
}
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test("the name is the identity's Vyre name, else the other device's, without .vyre.run", () => {
  assert.equal(nameOfPairing(PAIRED), "harlow");
  assert.equal(nameOfPairing({ name: "Awbox.vyre.run" }), "awbox");
});

test("the name is kept only when the list holds this device's key, and the ack is shown on the way", async () => {
  const { d, saved, kept } = stubs();
  const acks = [];
  const r = await addDeviceCore(d, { deviceLabel: "walk phone", onAck: (a) => acks.push(a) });
  assert.deepEqual(r, { name: "harlow", id: "per_x" });
  assert.deepEqual(acks, ["WINK-AAAA-BBBB"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].eid, "eid_me");
  assert.equal(saved[0].name, "harlow");
  assert.equal(kept.length, 1);
});

test("a list that does not hold the key keeps nothing", async () => {
  const { d, saved, kept } = stubs({ readList: async () => ({ ops: [], id: "per_x", eids: ["eid_other"], pin: null }) });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "not_listed");
  assert.equal(saved.length + kept.length, 0);
});

test("a list that cannot be read keeps nothing", async () => {
  const { d, saved } = stubs({ readList: async () => null });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "not_listed");
  assert.equal(saved.length, 0);
});

test("a wrong ack (the other device says no) keeps nothing", async () => {
  const { d, saved, kept } = stubs({ pair: async () => { throw Object.assign(new Error("no"), { code: "denied" }); } });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "denied");
  assert.equal(saved.length + kept.length, 0);
});

test("a timeout keeps nothing", async () => {
  const { d, saved, kept } = stubs({ pair: async () => { throw Object.assign(new Error("late"), { code: "expired" }); } });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "expired");
  assert.equal(saved.length + kept.length, 0);
});

test("an enrolment the other device could not make keeps nothing", async () => {
  const { d, saved } = stubs({ pair: async () => ({ ...PAIRED, enrolled: false, reason: "not their identity" }) });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "not_enrolled");
  assert.equal(saved.length, 0);
});

test("a device that already holds a name is refused before any key is made", async () => {
  let made = 0;
  const { d } = stubs({ held: async () => true, makeKey: async () => { made++; return KEY; } });
  await rejects(addDeviceCore(d, { deviceLabel: "p" }), "exists");
  assert.equal(made, 0);
});

test("a pairing that cannot be kept does not undo the name", async () => {
  const { d, saved } = stubs({ keepPairing: async () => { throw new Error("storage"); } });
  assert.equal((await addDeviceCore(d, { deviceLabel: "p" })).name, "harlow");
  assert.equal(saved.length, 1);
});
