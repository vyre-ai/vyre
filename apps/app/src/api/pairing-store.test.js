// @ts-check
// The pairing store on top of a keyed text store (pairing-store.ts): the older single record is migrated on the first change and the old key removed, saving a pairing adds it beside the others,
// `savePairing(null)` forgets only the active one, and two saves at once both land.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./pairing-store.ts");
const P = (/** @type {string} */ box) => ({ relay: "wss://relay.example.net", route: "r".repeat(26), box, name: `server ${box}`, device: `dev_${box}`, presence: null });
const memory = (/** @type {Record<string, string>} */ init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, io: { get: async (/** @type {string} */ k) => m.get(k) ?? null, set: async (/** @type {string} */ k, /** @type {string} */ v) => { await Promise.resolve(); m.set(k, v); }, del: async (/** @type {string} */ k) => { m.delete(k); } } };
};

test("pairing store: a device with the older single record still has its server, and nothing is rewritten by reading", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const { m, io } = memory({ "vyre.relay.pairing": JSON.stringify(P("boxa")) });
  const s = makePairingStore(io);
  assert.equal((await s.loadPairing())?.box, "boxa");
  assert.deepEqual([...m.keys()], ["vyre.relay.pairing"], "a read changes nothing on disk");
});

test("pairing store: the first save migrates to the list key and removes the old one", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const { m, io } = memory({ "vyre.relay.pairing": JSON.stringify(P("boxa")) });
  const s = makePairingStore(io);
  await s.savePairing(P("boxb"));
  assert.deepEqual([...m.keys()], ["vyre.relay.pairings"]);
  assert.deepEqual((await s.listPairings()).map((p) => p.box), ["boxa", "boxb"]);
  assert.equal((await s.loadPairing())?.box, "boxa", "the first server is still the active one");
});

test("pairing store: saving the same server twice keeps one; forgetting the active one hands over; forgetting the last empties the store", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const { m, io } = memory();
  const s = makePairingStore(io);
  await s.savePairing(P("boxa")); await s.savePairing(P("boxa")); await s.savePairing(P("boxb"));
  assert.equal((await s.listPairings()).length, 2);
  await s.savePairing(null);
  assert.deepEqual((await s.listPairings()).map((p) => p.box), ["boxb"]);
  assert.equal((await s.loadPairing())?.box, "boxb");
  await s.savePairing(null);
  assert.equal(await s.loadPairing(), null);
  assert.equal(m.size, 0, "no empty list is left behind");
});

test("pairing store: a named server is read, forgotten and made active on its own", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const s = makePairingStore(memory().io);
  await s.savePairing(P("boxa")); await s.savePairing(P("boxb"));
  assert.equal((await s.loadPairingFor("boxb"))?.name, "server boxb");
  assert.equal(await s.loadPairingFor("nope"), null);
  await s.setActivePairing("boxb");
  assert.equal((await s.loadPairing())?.box, "boxb");
  await s.removePairingFor("boxa");
  assert.deepEqual((await s.listPairings()).map((p) => p.box), ["boxb"]);
});

test("pairing store: two saves at once both land", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const s = makePairingStore(memory().io);
  await Promise.all([s.savePairing(P("boxa")), s.savePairing(P("boxb")), s.savePairing(P("boxc"))]);
  assert.deepEqual((await s.listPairings()).map((p) => p.box).sort(), ["boxa", "boxb", "boxc"]);
});

test("pairing store: a store that throws is an empty list and a save that fails does not throw", { skip: !strip }, async () => {
  const { makePairingStore } = await load();
  const s = makePairingStore({ get: async () => { throw new Error("locked"); }, set: async () => { throw new Error("full"); }, del: async () => { throw new Error("locked"); } });
  assert.equal(await s.loadPairing(), null);
  await s.savePairing(P("boxa"));
  await s.savePairing(null);
});
