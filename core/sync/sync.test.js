// @ts-check
// sync.upload on the box: a paired peer's own connection sends session files directly (ADR 0008
// 5a, e2e's session-import review). A minimal box-only registry; peer identity is a test seam
// (meta.peer), the same shape core/daemon/index.js's tailnet listener gives a real connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A box-role registry with the link and sync modules running (sync requires link's peerOf). */
async function boxRegistry(t) {
  const home = tempHome(t);
  const p = config.ensure(home);
  const found = discover([CORE]).filter(f => f.manifest && ["link", "sync"].includes(f.manifest.name));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", name: "testbox" }, paths: p, log: () => {} });
  await reg.start(found, { role: "box" });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await reg.stop(); db.close(); };
  t.after(stop);
  for (const name of ["link", "sync"]) assert.equal(reg.modules.get(name).state, "running", reg.modules.get(name).error);
  const call = (tool, input = {}, caller = "cli", meta = {}) => reg.call(tool, input, caller, meta);
  return { reg, db, events, call, root: home };
}

/** Pair a peer (kind "mac" or "device"), approved from the box's own socket. Returns its link_peers id and name. */
async function paired(call, { name = "alex-mac", stableId = "nPEER0001", kind } = {}) {
  const peer = { stableId, node: `${name}.tail0000.ts.net` };
  const req = await call("link.pair.request", { name, ...(kind ? { kind } : {}) }, "tailnet:owner", { peer });
  assert.ok(!req.error, JSON.stringify(req.error));
  const approved = await call("link.pair.approve", { code: req.data.code.replace("-", "") }, "cli");
  assert.ok(!approved.error, JSON.stringify(approved.error));
  return { peer: approved.data.peer, name };
}

const hash = s => crypto.createHash("sha256").update(s).digest("hex");

test("sync: a plan, an upload and a finish land the file in synced/<machine>/, once consent is on", async t => {
  const { call, events, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  const text = "line one\nline two\n";
  const h = hash(text);

  // Off by default: the box refuses before any byte moves.
  const before = await call("sync.upload.start", { path: "proj/a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  assert.equal(before.error?.code, "sync_disabled");

  const on = await call("sync.consent", { machine: name, on: true }, "cli");
  assert.deepEqual(on.data, { machine: name, on: true });

  const plan = await call("sync.upload.plan", { files: [{ path: "proj/a.jsonl", bytes: text.length, hash: h }] }, "tailnet:owner", { peer });
  assert.deepEqual(plan.data.new, ["proj/a.jsonl"]);
  assert.equal(plan.data.quota.used, 0);

  const start = await call("sync.upload.start", { path: "proj/a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(start.data, { upload: start.data.upload, offset: 0 });

  const seen = [];
  events.on("sync.progress", e => seen.push(e.payload));
  const chunk = await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  assert.deepEqual(chunk.data, { offset: text.length });

  const finish = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(finish.data, { ok: true, path: "proj/a.jsonl" });
  const landed = path.join(root, "synced", name, "proj", "a.jsonl");
  assert.equal(fs.readFileSync(landed, "utf8"), text);
  assert.deepEqual(seen.map(s => ({ path: s.path, done: s.done })), [{ path: "proj/a.jsonl", done: undefined }, { path: "proj/a.jsonl", done: true }]);

  // A second plan sees it as done, not new: dedupe.
  const plan2 = await call("sync.upload.plan", { files: [{ path: "proj/a.jsonl", bytes: text.length, hash: h }] }, "tailnet:owner", { peer });
  assert.deepEqual(plan2.data.done, ["proj/a.jsonl"]);
  assert.equal(plan2.data.quota.used, text.length);
});

test("sync: a resumed upload continues from what the box already holds, matched by path and hash", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  const text = "0123456789";
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from(text.slice(0, 4)) }, "tailnet:owner", { peer });
  // The same path and hash again (as after a device restart): resumes from offset 4, not 0.
  const again = await call("sync.upload.start", { path: "a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(again.data, { upload: start.data.upload, offset: 4 });
  const mid = await call("sync.upload.chunk", { upload: again.data.upload, offset: 0, data: Buffer.from("x") }, "tailnet:owner", { peer });
  assert.equal(mid.error?.code, "offset_mismatch");
  await call("sync.upload.chunk", { upload: again.data.upload, offset: 4, data: Buffer.from(text.slice(4)) }, "tailnet:owner", { peer });
  const finish = await call("sync.upload.finish", { upload: again.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.ok(!finish.error, JSON.stringify(finish.error));
  assert.equal(fs.readFileSync(path.join(root, "synced", name, "a.jsonl"), "utf8"), text);
});

test("sync: one peer can never resume or overwrite another's upload", async t => {
  const { call } = await boxRegistry(t);
  const a = await paired(call, { name: "device-a", stableId: "nAAA", kind: "device" });
  const b = await paired(call, { name: "device-b", stableId: "nBBB", kind: "device" });
  await call("sync.consent", { machine: a.name, on: true }, "cli");
  await call("sync.consent", { machine: b.name, on: true }, "cli");
  const h = hash("hello");
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 5, hash: h }, "tailnet:owner", { peer: { stableId: "nAAA" } });
  const stolen = await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from("hello") }, "tailnet:owner", { peer: { stableId: "nBBB" } });
  assert.equal(stolen.error?.code, "denied");
  const finishStolen = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer: { stableId: "nBBB" } });
  assert.equal(finishStolen.error?.code, "denied");
});

test("sync: a chunk over the cap, and an unpaired connection, are refused before anything is written", async t => {
  const { call } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 10, hash: hash("x") }, "tailnet:owner", { peer });
  const big = await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.alloc(4 * 1024 * 1024 + 1) }, "tailnet:owner", { peer });
  assert.equal(big.error?.code, "bad_input");
  const stranger = await call("sync.upload.plan", { files: [] }, "tailnet:owner", { peer: { stableId: "nNeverPaired" } });
  assert.equal(stranger.error?.code, "no_link");
  const noPeer = await call("sync.upload.plan", { files: [] }, "tailnet:owner", {});
  assert.equal(noPeer.error?.code, "no_link");
});

test("sync: over quota refuses before any byte moves, and a mac kind may sync too", async t => {
  const { call, db } = await boxRegistry(t);
  const { name, peer: id } = await paired(call, { kind: "mac" }); // "mac" kind is not import-only; it may still sync
  await call("sync.consent", { machine: name, on: true }, "cli"); // makes the sync_peers row
  db.prepare("UPDATE sync_peers SET quota_bytes = 5 WHERE peer = ?").run(id);
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 10, hash: hash("x") }, "tailnet:owner", { peer: { stableId: "nPEER0001" } });
  assert.equal(start.error?.code, "quota_exceeded");
});

test("sync: turning consent off, or unpairing, keeps everything the device sent — only sync.delete removes it (the user's overrule)", async t => {
  const { call, events, root } = await boxRegistry(t);
  const { name, peer: id } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  const text = "hi";
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  const dir = path.join(root, "synced", name);
  assert.ok(fs.existsSync(dir));

  const revoked = [];
  events.on("sync.revoked", e => revoked.push(e.payload));
  const off = await call("sync.consent", { machine: name, on: false }, "cli");
  assert.deepEqual(off.data, { machine: name, on: false });
  assert.ok(fs.existsSync(dir), "nothing already sent is touched by turning sync off");
  assert.deepEqual(revoked, [{ machine: name }], "sync.revoked still fires, informationally");
  // Off stops new uploads, but the file that's already there is untouched.
  assert.equal((await call("sync.upload.plan", { files: [] }, "tailnet:owner", { peer })).error?.code, "sync_disabled");

  // Unpairing keeps the data too.
  await call("link.unpair", { id }, "cli");
  assert.ok(fs.existsSync(dir), "unpairing keeps what the device sent — it belongs to the person");

  // Only the explicit, person-only sync.delete removes it — and only with confirm: true; without
  // it, a preview (counts), nothing deleted.
  const preview = await call("sync.delete", { machine: name }, "cli");
  assert.deepEqual(preview.data, { machine: name, files: 1, bytes: text.length, deleted: false, confirm: "call again with confirm: true to delete" });
  assert.ok(fs.existsSync(dir), "a preview deletes nothing");
  const deleted = [];
  events.on("sync.deleted", e => deleted.push(e.payload));
  const del = await call("sync.delete", { machine: name, confirm: true }, "cli");
  assert.deepEqual(del.data, { machine: name, files: 1, bytes: text.length, deleted: true });
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(deleted, [{ machine: name, files: 1, bytes: text.length }]);
  // A second delete finds nothing left to delete.
  assert.equal((await call("sync.delete", { machine: name, confirm: true }, "cli")).error?.code, "no_link");
});

test("sync: sync.delete is a person's own action, never a module's or an agent's", async t => {
  const { call } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  const h = hash("hi");
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 2, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from("hi") }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  for (const caller of ["mcp", "module:test"]) assert.equal((await call("sync.delete", { machine: name }, caller)).error?.code, "denied", caller);
});

test("sync: an unsafe file (a secret pasted into a chat) is quarantined, never landed where Recall reads", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  // Built at run time, not as a literal (test/hygiene.test.js scans shipped code for this shape).
  const text = "the user said: my key is sk-ant-api03-" + "a".repeat(44);
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  const finish = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(finish.data, { ok: true, quarantined: true, why: ["anthropic key"] });
  assert.ok(!fs.existsSync(path.join(root, "synced", name, "a.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "synced", ".quarantine", name, "a.jsonl")));
});

test("sync: a secret past the old 8 MB scrub bound is still caught (reviewer's MEDIUM: finish must scan the whole file, not just a prefix)", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  // Filler well past the old 8 MB scrub prefix, then a key, then a little more filler.
  const filler = "not a secret, just filler for this transcript\n".repeat(200_000); // ~9.4 MB
  assert.ok(filler.length > 8_000_000, "filler must exceed the old scrub bound to test anything");
  const text = filler + "the user said: my key is sk-ant-api03-" + "a".repeat(44) + "\n" + filler.slice(0, 1000);
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "big.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  const buf = Buffer.from(text);
  const CH = 2 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += CH) {
    const chunk = buf.subarray(off, Math.min(off + CH, buf.length));
    const r = await call("sync.upload.chunk", { upload: start.data.upload, offset: off, data: chunk }, "tailnet:owner", { peer });
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const finish = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(finish.data, { ok: true, quarantined: true, why: ["anthropic key"] });
  assert.ok(!fs.existsSync(path.join(root, "synced", name, "big.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "synced", ".quarantine", name, "big.jsonl")));
});

test("sync: a machine name with path-breaking characters still gets a safe folder on disk", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { name: "../../etc", stableId: "nWEIRD", kind: "device" });
  await call("sync.consent", { machine: name, on: true }, "cli");
  const peer = { stableId: "nWEIRD" };
  const text = "hi";
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  const finish = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.ok(!finish.error, JSON.stringify(finish.error));
  // Landed inside the box's own home, never escaping it through the weird name.
  assert.ok(fs.existsSync(path.join(root, "synced", ".._.._etc", "a.jsonl")));
  assert.ok(!fs.existsSync(path.join(root, "..", "..", "etc")));
});

test("sync: link.macs and link.macs.call never see a device-kind peer", async t => {
  const { call } = await boxRegistry(t);
  await paired(call, { name: "alex-mac", stableId: "nMAC0001", kind: "mac" });
  await paired(call, { name: "win-pc", stableId: "nDEV0001", kind: "device" });
  const macs = await call("link.macs", {}, "cli");
  assert.deepEqual(macs.data.map(m => m.name), ["alex-mac"]);
  const peers = await call("link.peers", {}, "cli");
  assert.deepEqual(peers.data.map(p => [p.name, p.kind]).sort(), [["alex-mac", "mac"], ["win-pc", "device"]]);
});

test("sync: a chunk can never grow an upload past what it declared, and finish books the real size (e2e review, quota bypass)", async t => {
  const { call, db } = await boxRegistry(t);
  const { name, peer: id } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  // Declares 1 byte, then tries to stream far more: refused before the disk grows unbounded.
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 1, hash: hash("x") }, "tailnet:owner", { peer });
  const big = await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.alloc(1024) }, "tailnet:owner", { peer });
  assert.equal(big.error?.code, "bad_input");
  assert.match(big.error?.message || "", /declared 1 bytes/);

  // A truthful declare, and finish books the real size on disk, not the declared number.
  const text = "0123456789";
  const h = hash(text);
  const start2 = await call("sync.upload.start", { path: "b.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start2.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: start2.data.upload, hash: h }, "tailnet:owner", { peer });
  const row = /** @type {any} */ (db.prepare("SELECT used_bytes FROM sync_peers WHERE peer = ?").get(id));
  assert.equal(row.used_bytes, text.length);
});

test("sync: in-flight declared bytes count against the quota, and at most a handful of uploads may be open at once (e2e review)", async t => {
  const { call } = await boxRegistry(t);
  const { name, peer: id } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");

  // Two parallel starts, each within quota alone, together exceed it: the second is refused.
  const a = await call("sync.upload.start", { path: "a.jsonl", bytes: 300, hash: hash("a") }, "tailnet:owner", { peer });
  assert.ok(!a.error);
  const b = await call("sync.upload.start", { path: "b.jsonl", bytes: 300, hash: hash("b") }, "tailnet:owner", { peer });
  assert.ok(!b.error); // still well under the 500 MB default
  // Cap on open uploads, independent of quota: fill it, then one more is refused.
  for (let i = 0; i < 6; i++) {
    const r = await call("sync.upload.start", { path: `f${i}.jsonl`, bytes: 10, hash: hash(`f${i}`) }, "tailnet:owner", { peer });
    assert.ok(!r.error, `upload ${i}: ${JSON.stringify(r.error)}`);
  }
  const over = await call("sync.upload.start", { path: "one-too-many.jsonl", bytes: 10, hash: hash("last") }, "tailnet:owner", { peer });
  assert.equal(over.error?.code, "too_many_open");
});

test("sync: resuming an already-open upload never counts against MAX_OPEN or the quota a second time (reviewer's LOW)", async t => {
  const { call, db } = await boxRegistry(t);
  const { name, peer: id } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  db.prepare("UPDATE sync_peers SET quota_bytes = 20 WHERE peer = ?").run(id);

  // Fill MAX_OPEN right up, one of them right at the quota's edge.
  const first = await call("sync.upload.start", { path: "a.jsonl", bytes: 20, hash: hash("a") }, "tailnet:owner", { peer });
  assert.ok(!first.error, JSON.stringify(first.error));
  for (let i = 0; i < 7; i++) {
    const r = await call("sync.upload.start", { path: `f${i}.jsonl`, bytes: 0, hash: hash(`f${i}`) }, "tailnet:owner", { peer });
    assert.ok(!r.error, `upload ${i}: ${JSON.stringify(r.error)}`);
  }
  // Genuinely full now: a new file is refused.
  assert.equal((await call("sync.upload.start", { path: "new.jsonl", bytes: 1, hash: hash("new") }, "tailnet:owner", { peer })).error?.code, "too_many_open");

  // But retrying the exact same path+hash as the first (a resume, same as after a device restart)
  // is neither refused by the open-uploads cap nor double-counted against the quota: it returns
  // the same upload id, not a new slot.
  const resumed = await call("sync.upload.start", { path: "a.jsonl", bytes: 20, hash: hash("a") }, "tailnet:owner", { peer });
  assert.deepEqual(resumed.data, { upload: first.data.upload, offset: 0 });
});

test("sync: sync.consent is a person's own action, never a module's", async t => {
  const { call } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  assert.equal((await call("sync.consent", { machine: name, on: true }, "module:test")).error?.code, "denied");
  assert.equal((await call("sync.consent", { machine: name, on: true }, "mcp")).error?.code, "denied");
  assert.ok(!(await call("sync.consent", { machine: name, on: true }, "cli")).error);
});

test("sync: safeDest refuses a symlink at the final path segment (e2e review: the check must not swallow its own denial)", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  // Land one real file, then make a symlink stand where the next upload's destination would be.
  const h1 = hash("hi");
  const s1 = await call("sync.upload.start", { path: "a.jsonl", bytes: 2, hash: h1 }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: s1.data.upload, offset: 0, data: Buffer.from("hi") }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: s1.data.upload, hash: h1 }, "tailnet:owner", { peer });
  const dir = path.join(root, "synced", name);
  fs.rmSync(path.join(dir, "a.jsonl"));
  fs.symlinkSync("/etc/hosts", path.join(dir, "a.jsonl"));
  // start() computes the same destination too (so a symlink planted there is caught as early as
  // possible, before a byte moves), so the refusal fires here rather than at finish.
  const h2 = hash("bye");
  const s2 = await call("sync.upload.start", { path: "a.jsonl", bytes: 3, hash: h2 }, "tailnet:owner", { peer });
  assert.equal(s2.error?.code, "denied");
  assert.match(s2.error?.message || "", /symlink/);
});

test("sync: cancel drops an open upload's slot and temp file, and is never another device's to cancel", async t => {
  const { call } = await boxRegistry(t);
  const a = await paired(call, { name: "device-a", stableId: "nAAA", kind: "device" });
  const b = await paired(call, { name: "device-b", stableId: "nBBB", kind: "device" });
  await call("sync.consent", { machine: a.name, on: true }, "cli");
  await call("sync.consent", { machine: b.name, on: true }, "cli");
  const start = await call("sync.upload.start", { path: "a.jsonl", bytes: 5, hash: hash("hello") }, "tailnet:owner", { peer: { stableId: "nAAA" } });
  await call("sync.upload.chunk", { upload: start.data.upload, offset: 0, data: Buffer.from("he") }, "tailnet:owner", { peer: { stableId: "nAAA" } });

  // Another device may not cancel it.
  const stolen = await call("sync.upload.cancel", { upload: start.data.upload }, "tailnet:owner", { peer: { stableId: "nBBB" } });
  assert.equal(stolen.error?.code, "denied");

  const cancelled = await call("sync.upload.cancel", { upload: start.data.upload }, "tailnet:owner", { peer: { stableId: "nAAA" } });
  assert.deepEqual(cancelled.data, { ok: true, cancelled: true });
  // Freed the slot: MAX_OPEN more starts now succeed where one would have been refused otherwise.
  for (let i = 0; i < 8; i++) {
    const r = await call("sync.upload.start", { path: `f${i}.jsonl`, bytes: 10, hash: hash(`f${i}`) }, "tailnet:owner", { peer: { stableId: "nAAA" } });
    assert.ok(!r.error, `upload ${i}: ${JSON.stringify(r.error)}`);
  }
  // Cancelling an id that no longer exists (already cancelled, finished, or never real) is not an error.
  assert.deepEqual((await call("sync.upload.cancel", { upload: start.data.upload }, "tailnet:owner", { peer: { stableId: "nAAA" } })).data, { ok: true, cancelled: false });
  assert.deepEqual((await call("sync.upload.cancel", { upload: "never-existed" }, "tailnet:owner", { peer: { stableId: "nAAA" } })).data, { ok: true, cancelled: false });
});

test("sync: a large upload's finish streams rather than holding the whole file at once, and lands byte-identical", async t => {
  const { call, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };
  await call("sync.consent", { machine: name, on: true }, "cli");
  // Bigger than the scrub's own bounded prefix, so finish must be reading the tail through the
  // stream rather than a first fs.readFileSync of the whole thing.
  const text = "line of a session transcript, nothing secret here\n".repeat(200_000); // ~10 MB
  const h = hash(text);
  const start = await call("sync.upload.start", { path: "big.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  const buf = Buffer.from(text);
  const CH = 2 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += CH) {
    const chunk = buf.subarray(off, Math.min(off + CH, buf.length));
    const r = await call("sync.upload.chunk", { upload: start.data.upload, offset: off, data: chunk }, "tailnet:owner", { peer });
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const finish = await call("sync.upload.finish", { upload: start.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.deepEqual(finish.data, { ok: true, path: "big.jsonl" });
  assert.equal(fs.readFileSync(path.join(root, "synced", name, "big.jsonl"), "utf8"), text);
});

test("sync.delete.import: removes only the files one approved plan sent, leaving a later plan's files and preview-then-confirm intact", async t => {
  const { call, events, root } = await boxRegistry(t);
  const { name } = await paired(call, { kind: "device" });
  const peer = { stableId: "nPEER0001" };

  // First import, approved as plan "planA".
  await call("sync.consent", { machine: name, on: true, planHash: "planA" }, "cli");
  const t1 = "from plan A";
  const h1 = hash(t1);
  const s1 = await call("sync.upload.start", { path: "a.jsonl", bytes: t1.length, hash: h1 }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: s1.data.upload, offset: 0, data: Buffer.from(t1) }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: s1.data.upload, hash: h1 }, "tailnet:owner", { peer });

  // A second, later import, approved as a different plan "planB".
  await call("sync.consent", { machine: name, on: true, planHash: "planB" }, "cli");
  const t2 = "from plan B";
  const h2 = hash(t2);
  const s2 = await call("sync.upload.start", { path: "b.jsonl", bytes: t2.length, hash: h2 }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: s2.data.upload, offset: 0, data: Buffer.from(t2) }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: s2.data.upload, hash: h2 }, "tailnet:owner", { peer });

  const dir = path.join(root, "synced", name);
  assert.ok(fs.existsSync(path.join(dir, "a.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "b.jsonl")));

  // Preview only, for plan A: nothing deleted yet.
  const preview = await call("sync.delete.import", { machine: name, planHash: "planA" }, "cli");
  assert.deepEqual(preview.data, { machine: name, planHash: "planA", files: 1, bytes: t1.length, deleted: false, confirm: "call again with confirm: true to delete" });
  assert.ok(fs.existsSync(path.join(dir, "a.jsonl")), "a preview deletes nothing");

  const deleted = [];
  events.on("sync.deleted", e => deleted.push(e.payload));
  const del = await call("sync.delete.import", { machine: name, planHash: "planA", confirm: true }, "cli");
  assert.deepEqual(del.data, { machine: name, planHash: "planA", files: 1, bytes: t1.length, deleted: true });
  assert.ok(!fs.existsSync(path.join(dir, "a.jsonl")), "plan A's file is gone");
  assert.ok(fs.existsSync(path.join(dir, "b.jsonl")), "plan B's file is untouched");
  assert.deepEqual(deleted, [{ machine: name, planHash: "planA", files: 1, bytes: t1.length }]);

  // Nothing left under plan A to delete a second time.
  assert.equal((await call("sync.delete.import", { machine: name, planHash: "planA", confirm: true }, "cli")).error?.code, "no_link");

  // Person-only, same as sync.delete.
  for (const caller of ["mcp", "module:test"]) {
    assert.equal((await call("sync.delete.import", { machine: name, planHash: "planB" }, caller)).error?.code, "denied", caller);
  }
});
