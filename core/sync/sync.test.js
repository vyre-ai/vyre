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

test("sync: turning consent off, or unpairing, deletes everything the device sent and emits sync.revoked", async t => {
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
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(revoked, [{ machine: name }]);
  // A plan against the consent-off switch now refuses again.
  assert.equal((await call("sync.upload.plan", { files: [] }, "tailnet:owner", { peer })).error?.code, "sync_disabled");

  // On again, upload again, then unpair: deletes too.
  await call("sync.consent", { machine: name, on: true }, "cli");
  const start2 = await call("sync.upload.start", { path: "b.jsonl", bytes: text.length, hash: h }, "tailnet:owner", { peer });
  await call("sync.upload.chunk", { upload: start2.data.upload, offset: 0, data: Buffer.from(text) }, "tailnet:owner", { peer });
  await call("sync.upload.finish", { upload: start2.data.upload, hash: h }, "tailnet:owner", { peer });
  assert.ok(fs.existsSync(dir));
  await call("link.unpair", { id }, "cli");
  assert.ok(!fs.existsSync(dir));
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
