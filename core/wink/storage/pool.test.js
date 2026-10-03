// @ts-check
// The storage-to-pool adapter against a fake with the shape of the pool engine (work/sealing kernel/storage/pool.js): addNode, nodes, used, drain, forget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../store/index.js";
import { createStorageDevices, MIGRATIONS } from "./index.js";
import { storageGrants } from "./grants.js";
import { attachPool } from "./pool.js";
import { fakeS3 } from "./testing/fake-s3.js";

const SPACE = "spc_abcdefghijkl";
const SECRET = "Zx9-very-secret-value-42";
const ACCESS = "AKFAKE1ACCESS";
const SELF = { kind: "person", id: "per_alexalexalexalexalexalexal", space: SPACE };

/** The engine's surface, in memory: a node is { id, backend, kind, owned, offered }, `held` is what the engine says it stores. */
function fakePool() {
  const nodes = new Map(), held = new Map(), drained = [];
  return {
    nodes, held, drained, failDrain: /** @type {string | null} */ (null),
    addNode(n) { if (nodes.has(n.id)) throw Object.assign(new Error("exists"), { code: "exists" }); nodes.set(n.id, n); return n.id; },
    used: id => held.get(id) || 0,
    async drain(id) { if (this.failDrain) throw Object.assign(new Error("x"), { code: this.failDrain }); nodes.delete(id); drained.push(id); return { moved: 1 }; },
    forget(id) { nodes.delete(id); },
  };
}

async function world(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  migrate(db, "wink-storage", MIGRATIONS);
  const events = [], logs = [];
  const ctx = { store: { db }, events: { emit: (type, payload) => events.push({ type, payload }) }, log: m => logs.push(m), config: { name: "Alex's Mac" } };
  const items = new Map();
  const vault = { put: async ({ name, fields }) => { items.set(name, { fields }); }, fetch: async (name, field) => items.get(name).fields[field], remove: async name => { items.delete(name); } };
  const bucket = await fakeS3({ bucket: "harlow-backup", accessKey: ACCESS, secretKey: SECRET });
  t.after(bucket.close);
  const s = createStorageDevices({
    ctx, vault, grants: storageGrants({ ctx, space: () => SPACE }), space: () => SPACE, scanners: [],
    admin: { self: async () => SELF, isAdmin: async (p, sp) => p === SELF.id && sp === SPACE, nameOf: async () => "Harlow Legal" },
  });
  const pool = fakePool();
  const made = [];
  const link = attachPool({ storage: s, pool, by: () => SELF, log: m => logs.push(m), makeBackend: (c, offer) => { made.push({ c, offer }); return { id: offer.id }; } });
  const pairArgs = { kind: "s3", endpoint: bucket.endpoint, bucket: "harlow-backup", region: "us-east-1", accessKey: ACCESS, secretKey: SECRET, capacity: 1.5e12, owner: `space:${SPACE}` };
  return { s, pool, link, made, items, events, logs, pairArgs, db };
}

test("a paired bucket becomes a pool node through getCredentials, once, and the engine's usage flows back", async t => {
  const w = await world(t);
  const { device } = await w.s.pair(w.pairArgs);
  const r = await w.link.sync();
  assert.deepEqual(r.added, [device.id]);
  assert.equal(w.made[0].c.accessKey, ACCESS, "the backend was built from the vault's details");
  const node = w.pool.nodes.get(device.id);
  assert.equal(node.kind, "s3");
  assert.equal(node.offered, 1.5e12);
  assert.equal(node.owned, false);
  assert.deepEqual((await w.link.sync()).added, [], "a second pass adds nothing");
  w.pool.held.set(device.id, 4096);
  await w.link.sync();
  assert.equal(w.s.offers()[0].storage.used, 4096);
  assert.ok(![...w.logs, JSON.stringify(w.events), JSON.stringify(r)].join("\n").includes(SECRET), "no access detail in events, logs or the result");
});

test("the pool's credential read is the owner's: another actor gets nothing and the device is skipped, not added", async t => {
  const w = await world(t);
  await w.s.pair(w.pairArgs);
  const link = attachPool({ storage: w.s, pool: w.pool, by: () => ({ kind: "person", id: "per_someoneelse" }), makeBackend: () => ({}) });
  const r = await link.sync();
  assert.equal(r.added.length, 0);
  assert.equal(r.skipped[0].why, "denied");
  assert.equal(w.pool.nodes.size, 0);
});

test("a drain: the engine copies off, then the device is released and its login is gone; a stuck drain waits and is retried", async t => {
  const w = await world(t);
  const { device } = await w.s.pair(w.pairArgs);
  await w.link.sync();
  await w.s.remove({ id: device.id, drain: true });
  w.pool.failDrain = "no_room";
  let r = await w.link.sync();
  assert.deepEqual(r.blocked, [{ id: device.id, code: "no_room" }]);
  assert.equal(w.s.offers().length, 1, "still listed while it waits");
  w.pool.failDrain = null;
  r = await w.link.sync();
  assert.deepEqual(r.drained, [device.id]);
  assert.deepEqual(w.pool.drained, [device.id]);
  assert.equal(w.s.offers().length, 0);
  assert.equal(w.items.size, 0, "the saved login went with it");
});

test("a device removed without a drain is forgotten by the pool, and the home node is never touched", async t => {
  const w = await world(t);
  w.pool.addNode({ id: "home", backend: {}, home: true });
  const { device } = await w.s.pair(w.pairArgs);
  await w.link.sync();
  assert.ok(w.pool.nodes.has(device.id));
  await w.s.remove({ id: device.id });
  const r = await w.link.sync();
  assert.deepEqual(r.forgotten, [device.id]);
  assert.ok(w.pool.nodes.has("home"));
});

test("with no pool engine the pass does nothing", async t => {
  const w = await world(t);
  await w.s.pair(w.pairArgs);
  const link = attachPool({ storage: w.s, pool: () => null, by: () => SELF, makeBackend: () => ({}) });
  assert.deepEqual((await link.sync()).added, []);
});
