// @ts-check
// The storage pool: classes and copy counts, encryption before it leaves, healing, draining, capacity and the one number, quotas, residency.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool, CLASSES } from "./pool.js";
import { memoryBackend, dirBackend } from "./backends.js";
import { tmp } from "../seal/testing.js";

const KEY = Buffer.alloc(32, 7), code = p => p.then(() => null, e => e.code);
const MB = 1 << 20, rand = n => crypto.randomBytes(n);
/** A pool with a home and some other places, all in memory. */
function world(t, spec = { home: 10, nas: 10, cloud: 10 }, opts = {}) {
  const dir = tmp("pool"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000; const pool = new Pool({ dir, key: KEY, now: () => clock, chunk: MB, ...opts }), b = {};
  for (const [id, mb] of Object.entries(spec)) { b[id] = memoryBackend(); pool.addNode({ id, backend: b[id], home: id === "home", kind: id === "home" ? "server" : id === "nas" ? "network_drive" : "s3", site: id, offered: mb * MB }); }
  return { pool, b, dir, tick: ms => { clock += ms; }, holders: cid => pool.ix.chunks[cid].nodes };
}
const chunkIds = (pool, id) => pool.ix.manifests[id].chunks;

test("a round trip across chunks, and no node ever holds plaintext", async t => {
  const { pool, b } = world(t), data = Buffer.concat([rand(MB + 500), Buffer.from("Harlow Legal estate file ".repeat(5000))]);
  const r = await pool.put(data, { class: "working" });
  assert.equal(r.atRisk, false); assert.deepEqual(await pool.get(r.id), data);
  for (const be of Object.values(b)) for (const blob of be.m.values()) assert.equal(blob.includes(Buffer.from("Harlow Legal")), false);
  const other = new Pool({ dir: tmp("pool2"), key: Buffer.alloc(32, 9), chunk: MB }); const cid = chunkIds(pool, r.id)[0];
  assert.equal(other.open(cid, b.home.m.get(`c/${cid}`)), null, "another owner's key opens nothing");
});

test("classes: working is home plus one replica, cold is two nodes, backup is off the home, hot is refused", async t => {
  const { pool, holders } = world(t), d = rand(1000);
  const w = await pool.put(d, { class: "working" }), c = await pool.put(rand(1000), { class: "cold" }), k = await pool.put(rand(1000), { class: "backup" });
  const hw = holders(chunkIds(pool, w.id)[0]), hc = holders(chunkIds(pool, c.id)[0]), hk = holders(chunkIds(pool, k.id)[0]);
  assert.ok(hw.includes("home") && hw.length === 2); assert.equal(hc.length, 2); assert.equal(new Set(hc).size, 2);
  assert.ok(hk.length >= 1 && !hk.includes("home"), "a backup is never only on the home");
  assert.equal(await code(pool.put(d, { class: "hot" })), "hot_not_pooled");
  assert.equal(await code(pool.put(d, { class: "nope" })), "bad_class");
  assert.throws(() => pool.addNode({ id: "p", backend: memoryBackend(), kind: "phone" }), /phones_do_not/);
  assert.deepEqual(Object.keys(CLASSES).sort(), ["backup", "cold", "rebuildable", "working"]);
});

test("equal content is stored once, and removing one reader keeps it for the other", async t => {
  const { pool, b } = world(t), d = rand(3000);
  const a = await pool.put(d, { class: "cold" }), a2 = await pool.put(d, { class: "cold" });
  assert.equal(Object.keys(pool.ix.chunks).length, 1);
  await pool.remove(a.id); assert.deepEqual(await pool.get(a2.id), d);
  await pool.remove(a2.id); assert.equal(Object.keys(pool.ix.chunks).length, 0); assert.equal([...Object.values(b)].reduce((n, x) => n + x.m.size, 0), 0);
});

test("a node that drops out: reads keep working, the copy counts during the grace period, and past it healing makes a new one", async t => {
  const { pool, b, tick, holders } = world(t, { home: 10, nas: 10, cloud: 10, extra: 10 }), data = rand(MB * 2);
  const r = await pool.put(data, { class: "cold" }), cid = chunkIds(pool, r.id)[0], lost = holders(cid)[0];
  b[lost].down = true; assert.deepEqual(await pool.probe(), [lost]);
  assert.deepEqual(await pool.get(r.id), data, "a read comes from the other copy");
  assert.deepEqual(await pool.heal(), { copied: 0, atRisk: 0, unreachable: 0 }, "inside the grace period nothing moves");
  assert.match(pool.report().nudges.join(" "), /Nothing is at risk/);
  tick(11 * 60_000); const h = await pool.heal(); assert.ok(h.copied >= 1 && h.atRisk === 0);
  assert.ok(pool.held(pool.ix.chunks[cid]).length >= 2 && !pool.held(pool.ix.chunks[cid]).some(n => n.id === lost));
  assert.deepEqual(await pool.get(r.id), data);
});

test("a copy that was changed behind the pool's back is never returned, and the next copy is used", async t => {
  const { pool, b, holders } = world(t), d = rand(5000), r = await pool.put(d, { class: "cold" }), cid = chunkIds(pool, r.id)[0];
  const first = holders(cid)[0], blob = Buffer.from(b[first].m.get(`c/${cid}`)); blob[20] ^= 1; b[first].m.set(`c/${cid}`, blob);
  assert.deepEqual(await pool.get(r.id), d);
  for (const n of holders(cid).slice(1)) { const x = Buffer.from(b[n].m.get(`c/${cid}`)); x[20] ^= 1; b[n].m.set(`c/${cid}`, x); }
  assert.equal(await code(pool.get(r.id)), "unavailable");
});

test("withdrawing a node drains it first, refuses when the others lack room, and a node lost for good is healed around", async t => {
  const { pool, b } = world(t, { home: 10, nas: 10, cloud: 10 }), data = rand(MB * 3), r = await pool.put(data, { class: "working" });
  await pool.put(rand(MB * 2), { class: "cold" });
  const out = await pool.drain("nas"); assert.ok(out.moved > 0); assert.equal(pool.nodes.has("nas"), true === false);
  assert.equal(b.nas.m.size, 0, "everything was copied off and cleared");
  assert.equal(pool.report().stored > 0, true); assert.deepEqual(await pool.get(r.id), data);
  for (const c of Object.values(pool.ix.chunks)) assert.ok(pool.satisfied(c));
  // Not enough room elsewhere: refused, the node stays.
  const small = world(t, { home: 4, nas: 4 }); await small.pool.put(rand(MB * 3), { class: "working" });
  assert.equal(await code(small.pool.drain("nas")), "no_room"); assert.equal(small.pool.nodes.has("nas"), true);
  // Lost for good.
  pool.forget("cloud"); const h = await pool.heal(); assert.equal(h.unreachable, 0); assert.deepEqual(await pool.get(r.id), data);
});

test("the one number is usable space after copies; rebuildable things are given up first and nothing else; a full pool says so and leaves nothing behind", async t => {
  const { pool, b } = world(t, { home: 5, nas: 5 });
  assert.equal(pool.report().usable, 5 * MB, "10 MB raw with two copies is 5 MB usable");
  const rb = await pool.put(rand(MB), { class: "rebuildable" }), w = await pool.put(rand(2 * MB), { class: "working" });
  assert.equal(await pool.evict(MB), MB); assert.equal(pool.ix.manifests[rb.id], undefined); assert.ok(pool.ix.manifests[w.id], "working data is never given up");
  assert.equal(await pool.evict(10 * MB), 0, "nothing else is evictable");
  const before = Object.values(b).map(x => x.m.size);
  assert.equal(await code(pool.put(rand(8 * MB), { class: "cold" })), "no_room", "a write that cannot be placed says so");
  assert.deepEqual(Object.values(b).map(x => x.m.size), before, "the failed write left no orphan chunks");
  assert.equal((await pool.get(w.id)).length, 2 * MB, "reads always work");
});

test("backups with no second place say so, and a meter stops one project filling the pool", async t => {
  const { pool } = world(t, { home: 10, nas: 10 }, { quotas: { "project:a": 3000 } });
  await pool.put(rand(100), { class: "backup" }); pool.forget("nas");
  assert.match(pool.report().nudges.join(" "), /Backups need a second place/);
  await pool.put(rand(2000), { class: "cold", meter: "project:a" });
  assert.equal(await code(pool.put(rand(2000), { class: "cold", meter: "project:a" })), "quota");
  assert.equal(pool.ix.meters["project:a"], 2000);
});

test("residency: a space that says owned places only uses nodes it owns", async t => {
  const dir = tmp("res"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new Pool({ dir, key: KEY, policy: { ownedOnly: true }, chunk: MB }), mine = memoryBackend(), rented = memoryBackend();
  pool.addNode({ id: "home", backend: mine, home: true, offered: 5 * MB }); pool.addNode({ id: "bucket", backend: rented, kind: "s3", owned: false, offered: 50 * MB });
  const r = await pool.put(rand(1000), { class: "cold" }); assert.equal(r.atRisk, true); assert.equal(rented.m.size, 0, "nothing went to the rented bucket");
  assert.equal(pool.report().raw_free <= 5 * MB, true);
});

test("a node with copies inside itself (a SeaweedFS service at replication 010) satisfies two copies alone", async t => {
  const dir = tmp("sw"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new Pool({ dir, key: KEY, chunk: MB }); pool.addNode({ id: "svc", backend: memoryBackend(), kind: "s3", copies: 2, offered: 5 * MB });
  assert.equal((await pool.put(rand(1000), { class: "cold" })).atRisk, false);
});

test("a directory node (a mounted drive) works and the index survives a restart", async t => {
  const dir = tmp("dirpool"), drive = tmp("drive"); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(drive, { recursive: true, force: true }); });
  const mk = () => { const p = new Pool({ dir, key: KEY, chunk: MB }); p.addNode({ id: "home", backend: dirBackend(path.join(drive, "home")), home: true, offered: 50 * MB }); p.addNode({ id: "usb", backend: dirBackend(path.join(drive, "usb")), offered: 50 * MB }); return p; };
  const p1 = mk(), data = rand(MB + 10), r = await p1.put(data, { class: "working" });
  assert.deepEqual(await mk().get(r.id), data);
  assert.deepEqual(await p1.probe(), []); assert.ok(p1.nodes.get("usb").deviceFree > 0);
  assert.ok(fs.readdirSync(drive, { recursive: true }).every(f => !String(f).endsWith(".tmp")));
});
