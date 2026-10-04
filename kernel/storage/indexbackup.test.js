// @ts-check
// The index backup: written off the home, encrypted, versioned; a new home rebuilds from the pool alone, refuses a rollback, and the nodes see nothing readable.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool } from "./pool.js";
import { Drive } from "./drive.js";
import { memoryBackend } from "./backends.js";
import { backupIndex, restoreIndex, openIndex } from "./indexbackup.js";
import { createController } from "./controller.js";
import { tmp } from "../seal/testing.js";

const MB = 1 << 20, KEY = Buffer.alloc(32, 6), OWNER = "spc_harlowharlowharlow", rand = n => crypto.randomBytes(n), code = p => p.then(() => null, e => e.code);
function home(t, backends, dirName = "home") {
  const dir = tmp(dirName); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new Pool({ dir, key: KEY, chunk: MB }); pool.addNode({ id: "home", backend: backends.home ?? (backends.home = memoryBackend()), home: true, offered: 50 * MB });
  for (const id of ["nas", "cloud"]) pool.addNode({ id, backend: backends[id] ??= memoryBackend(), kind: id === "nas" ? "network_drive" : "s3", offered: 50 * MB });
  return { pool, dir, drive: new Drive(pool) };
}

test("the home dies: a new home rebuilds the index and the Drive from the pool alone and reads a file back", async t => {
  const b = {}, h = home(t, b), doc = rand(2 * MB + 77), note = Buffer.from("Harlow Legal estate plan, Northwind Bakery trust");
  await h.drive.put("clients/jane/estate.pdf", doc, { by: "per_alex" }); await h.drive.put("clients/jane/estate.pdf", note, { by: "per_alex", base: 1 });
  const head = await backupIndex({ pool: h.pool, drive: h.drive, key: KEY, owner: OWNER }); assert.equal(head.seq, 1); assert.ok(head.copies >= 2 && !head.atRisk);
  assert.equal(b.home.m.has("i/latest"), false, "the backup is off the home");
  for (const n of ["nas", "cloud"]) for (const blob of [b[n].m.get("i/latest"), b[n].m.get("i/1")]) assert.equal(blob.includes(Buffer.from("Harlow")) || blob.includes(Buffer.from("estate")), false, "nodes hold nothing readable");
  // The home is gone: its disk, its index and its drive file. Only the storage nodes remain.
  const gone = { nas: b.nas, cloud: b.cloud }, dir = tmp("newhome"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await restoreIndex({ dir, key: KEY, owner: OWNER, nodes: [{ id: "nas", backend: gone.nas }, { id: "cloud", backend: gone.cloud }], expected: { seq: head.seq, hash: head.hash } });
  assert.equal(r.unverified, false); assert.deepEqual(r.lost_nodes, ["home"]);
  const pool = new Pool({ dir, key: KEY, chunk: MB }); pool.addNode({ id: "home", backend: memoryBackend(), home: true, offered: 50 * MB }); pool.addNode({ id: "nas", backend: gone.nas, kind: "network_drive", offered: 50 * MB }); pool.addNode({ id: "cloud", backend: gone.cloud, kind: "s3", offered: 50 * MB });
  const drive = new Drive(pool); assert.deepEqual(drive.list().map(f => f.path), ["clients/jane/estate.pdf"]);
  assert.deepEqual(await drive.get("clients/jane/estate.pdf"), note); assert.deepEqual(await drive.get("clients/jane/estate.pdf", { version: 1 }), doc);
  const heal = await pool.heal(); assert.equal(heal.atRisk, 0); for (const c of Object.values(pool.ix.chunks)) assert.ok(pool.satisfied(c), "copies remade on the new home");
});

test("rollback: an older index served by a node is refused when the owner's head is known, and flagged unverified when it is not", async t => {
  const b = {}, h = home(t, b); await h.drive.put("a.txt", rand(1000));
  const h1 = await backupIndex({ pool: h.pool, drive: h.drive, key: KEY, owner: OWNER }); const old = Buffer.from(b.nas.m.get("i/latest")), oldCloud = Buffer.from(b.cloud.m.get("i/latest"));
  await h.drive.put("b.txt", rand(1000)); const h2 = await backupIndex({ pool: h.pool, drive: h.drive, key: KEY, owner: OWNER }); assert.equal(h2.seq, 2);
  b.nas.m.set("i/latest", old); b.cloud.m.set("i/latest", oldCloud); // every node serves the old one
  const nodes = [{ id: "nas", backend: b.nas }, { id: "cloud", backend: b.cloud }], dir = tmp("rb"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await code(restoreIndex({ dir, key: KEY, owner: OWNER, nodes, expected: { seq: h2.seq, hash: h2.hash } })), "rollback");
  const r = await restoreIndex({ dir, key: KEY, owner: OWNER, nodes }); assert.equal(r.seq, 1); assert.equal(r.unverified, true, "without a head an old index cannot be told from the current one");
  // One honest node is enough to beat a lying one: the highest sequence wins.
  b.cloud.m.set("i/latest", b.cloud.m.get("i/2")); assert.equal((await restoreIndex({ dir, key: KEY, owner: OWNER, nodes })).seq, 2);
  void h1;
});

test("a node cannot forge or alter an index: another key, another owner, a flipped bit and a raised sequence all open nothing", async t => {
  const b = {}, h = home(t, b); await h.drive.put("a.txt", rand(500)); await backupIndex({ pool: h.pool, drive: h.drive, key: KEY, owner: OWNER });
  const blob = Buffer.from(b.nas.m.get("i/latest"));
  assert.ok(openIndex(KEY, OWNER, blob)); assert.equal(openIndex(Buffer.alloc(32, 9), OWNER, blob), null); assert.equal(openIndex(KEY, "spc_otherotherotherothe", blob), null);
  const flip = Buffer.from(blob); flip[blob.length - 30] ^= 1; assert.equal(openIndex(KEY, OWNER, flip), null);
  const raised = Buffer.from(blob); raised.writeBigUInt64BE(99n, 5); assert.equal(openIndex(KEY, OWNER, raised), null, "the sequence is authenticated");
  const dir = tmp("forge"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  b.nas.m.set("i/latest", flip); b.cloud.m.set("i/latest", Buffer.from("junk"));
  assert.equal(await code(restoreIndex({ dir, key: KEY, owner: OWNER, nodes: [{ id: "nas", backend: b.nas }, { id: "cloud", backend: b.cloud }] })), "no_index");
});

test("the controller backs up on a schedule and after a large change, and says so in one event", async t => {
  const b = {}, h = home(t, b); let clock = 10_000_000; h.pool.now = () => clock; const events = [];
  const c = createController({ pool: h.pool, emit: e => events.push(e), setTimer: () => ({}), clearTimer: () => {}, dirtyBytes: 3 * MB, backupEveryMs: 3_600_000, backup: () => backupIndex({ pool: h.pool, drive: h.drive, key: KEY, owner: OWNER }) });
  await c.tick(); assert.equal(events.filter(e => e.type === "storage.index").length, 0, "nothing changed, nothing written");
  await h.drive.put("small.txt", rand(1000)); await c.tick(); assert.equal(events.filter(e => e.type === "storage.index").length, 1, "the first change is backed up at once: there is no index off the home yet");
  await h.drive.put("small2.txt", rand(1000)); await c.tick(); assert.equal(events.filter(e => e.type === "storage.index").length, 1, "a small change waits for the hour");
  clock += 3_600_001; await c.tick(); assert.equal(events.filter(e => e.type === "storage.index").length, 2);
  await h.drive.put("big.bin", rand(4 * MB)); await c.tick(); const idx = events.filter(e => e.type === "storage.index"); assert.equal(idx.length, 3, "a large change does not wait"); assert.equal(idx[2].seq, 3); assert.match(idx[2].hash, /^[0-9a-f]{64}$/);
  await c.tick(); assert.equal(events.filter(e => e.type === "storage.index").length, 3);
});
