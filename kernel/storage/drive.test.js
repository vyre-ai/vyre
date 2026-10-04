// @ts-check
// VyreDrive on the pool: versions, conflicts that are kept not merged, deletes that can be undone, pruning, backups, safe paths, and the bytes only ever in the pool.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool } from "./pool.js";
import { Drive } from "./drive.js";
import { memoryBackend } from "./backends.js";
import { tmp } from "../seal/testing.js";

const MB = 1 << 20, rand = n => crypto.randomBytes(n), code = p => p.then(() => null, e => e.code);
function world(t) {
  const dir = tmp("drive"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000; const pool = new Pool({ dir, key: Buffer.alloc(32, 5), now: () => clock, chunk: MB }), b = { home: memoryBackend(), nas: memoryBackend(), cloud: memoryBackend() };
  pool.addNode({ id: "home", backend: b.home, home: true, offered: 50 * MB }); pool.addNode({ id: "nas", backend: b.nas, offered: 50 * MB }); pool.addNode({ id: "cloud", backend: b.cloud, kind: "s3", offered: 50 * MB });
  const drive = new Drive(pool, { now: () => clock });
  return { pool, drive, b, tick: ms => { clock += ms; } };
}

test("a file round trips, versions are kept, and only the newest is working data", async t => {
  const { drive, pool } = world(t), v1 = rand(5000), v2 = rand(6000);
  assert.deepEqual(await drive.put("clients/jane/notes.txt", v1, { by: "per_alex" }), { version: 1, conflict: false, atRisk: false });
  assert.deepEqual(await drive.put("clients/jane/notes.txt", v2, { by: "per_alex", base: 1 }), { version: 2, conflict: false, atRisk: false });
  assert.deepEqual(await drive.get("clients/jane/notes.txt"), v2); assert.deepEqual(await drive.get("clients/jane/notes.txt", { version: 1 }), v1);
  assert.deepEqual(drive.history("clients/jane/notes.txt").map(v => v.ver), [1, 2]);
  const cls = ix => pool.ix.manifests[drive.ix.files["clients/jane/notes.txt"].versions[ix].id].class;
  assert.equal(cls(0), "cold"); assert.equal(cls(1), "working");
  assert.deepEqual(drive.list("clients/").map(f => [f.path, f.version]), [["clients/jane/notes.txt", 2]]);
});

test("two writers on one file give two versions, never a merge, and a restore settles it", async t => {
  const { drive } = world(t), base = rand(2000);
  await drive.put("plan.docx", base, { by: "per_alex" });
  const a = await drive.put("plan.docx", rand(2100), { by: "per_alex", base: 1 }), b = await drive.put("plan.docx", rand(2200), { by: "per_sam", base: 1 });
  assert.equal(a.conflict, false); assert.equal(b.conflict, true); assert.equal(drive.list()[0].conflicts, 1);
  assert.equal((await drive.get("plan.docx")).length, 2200, "the newest write is the head, the other is one tap away");
  assert.equal((await drive.get("plan.docx", { version: 2 })).length, 2100);
  const r = await drive.restore("plan.docx", 2, { by: "per_alex" }); assert.equal(r.version, 4); assert.equal((await drive.get("plan.docx")).length, 2100); assert.equal(drive.list()[0].conflicts, 0);
});

test("a delete is a version and can be undone; prune lets old versions go and frees their room", async t => {
  const { drive, pool, tick } = world(t), d = rand(3000);
  await drive.put("a.txt", d); await drive.delete("a.txt", { by: "per_alex" });
  assert.equal(await code(drive.get("a.txt")), "not_found"); assert.deepEqual(drive.list(), []);
  assert.deepEqual(await drive.get("a.txt", { version: 1 }), d); assert.equal(await code(drive.get("a.txt", { version: 2 })), "deleted_version");
  await drive.restore("a.txt", 1); assert.deepEqual(await drive.get("a.txt"), d);
  for (let i = 0; i < 4; i++) await drive.put("a.txt", rand(MB), { base: drive.history("a.txt").at(-1).ver });
  const before = pool.report().stored; tick(40 * 86_400_000);
  const { freed } = await drive.prune({ keep: 2 }); assert.ok(freed > 0 && pool.report().stored < before);
  assert.equal((await drive.get("a.txt")).length, MB, "the newest versions survive");
});

test("paths that reach outside or hide something are refused, and the stored bytes are ciphertext on every node", async t => {
  const { drive, b } = world(t);
  for (const p of ["../x", "a/../../b", "/abs", "a//b", "a/%2e%2e/b", "a\\b", "", "con.txt", "x".repeat(2000)]) assert.equal(await code(drive.put(p, rand(10))), "bad_path", p);
  await drive.put("harlow/estate.txt", Buffer.from("Harlow Legal estate plan, Northwind Bakery trust ".repeat(100)));
  for (const be of Object.values(b)) for (const blob of be.m.values()) assert.equal(blob.includes(Buffer.from("Harlow Legal")), false);
});

test("the index survives a restart, and backups keep the newest few and never the last one away", async t => {
  const { drive, pool } = world(t); await drive.put("keep.txt", rand(500));
  const again = new Drive(pool); assert.equal(again.list().length, 1); assert.equal((await again.get("keep.txt")).length, 500);
  for (let i = 0; i < 5; i++) await drive.backup("harlow-home", rand(1000 + i));
  assert.equal(drive.backups("harlow-home").length, 5);
  const r = await drive.pruneBackups("harlow-home", 2); assert.equal(r.removed, 3); assert.equal((await drive.restoreBackup("harlow-home")).length, 1004);
  assert.equal((await drive.pruneBackups("harlow-home", 0)).removed, 1, "keep 0 still keeps the last one");
  const b = drive.ix.backups["harlow-home"][0], holders = pool.ix.chunks[pool.ix.manifests[b.id].chunks[0]].nodes; assert.ok(holders.some(n => n !== "home"), "a backup is off the home");
});

test("a version that cannot be recorded leaves nothing behind: no new version and no orphan object in the pool", async t => {
  const { drive, pool } = world(t); await drive.put("a.txt", rand(1000));
  const objects = () => Object.keys(pool.ix.manifests).length, before = objects(), realReclass = pool.reclass.bind(pool);
  pool.reclass = async () => { throw new Error("the pool could not reclass"); };
  await assert.rejects(drive.put("a.txt", rand(2000), { base: 1 }), /could not reclass/);
  assert.deepEqual(drive.history("a.txt").map(v => v.ver), [1], "the refused version is not in the history"); assert.equal(objects(), before, "and its bytes were removed from the pool");
  pool.reclass = realReclass; assert.equal((await drive.put("a.txt", rand(2000), { base: 1 })).version, 2, "the next write is version 2");
});
