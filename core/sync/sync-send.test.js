// @ts-check
// sync.send end to end: a real Mac and box, paired over the simulated tailnet (test/link-harness.js),
// with the daemon's real router so the raw chunk route (POST /v1/sync/upload/<id>) is reached too,
// not only the tool logic (core/sync/sync.test.js covers that directly and more thoroughly).

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pair } from "../../test/link-harness.js";

const hash = s => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Where sync.send and sync.scan read this device's own Claude Code folder from: core/config's
 * claudeHome(root) rule (real only for the real ~/.vyre), so for the Mac's temp VYRE_HOME in
 * these tests it is always `<macRoot>/claude` — never the real ~/.claude, whatever env var is
 * set. No env var needed to fake it: just make that folder.
 */
function fakeSessions(macRoot) {
  const dir = path.join(macRoot, "claude");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("sync.send: a device's own file reaches the box over the real link, chunked route included", async t => {
  const s = await pair(t, { router: true });
  await s.boxCall("sync.consent", { machine: "test-mac", on: true }, "cli");
  const sessions = fakeSessions(s.macRoot);

  const text = "line one\nline two\n".repeat(200); // a few chunks' worth, at a small SEND_CHUNK in tests would help, but 1 MB default covers this in one
  const file = path.join(sessions, "session1.jsonl");
  fs.writeFileSync(file, text);
  const h = hash(text);

  // memory-iq's import module is the door; "module:import" stands in for it, with the firstParty
  // flag the loader itself stamps on a module-to-module call (ctx.call never lets a module set
  // this — see core/sync/sync.test.js for the "label alone is not enough" spoof case).
  const r = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:import", { firstParty: true });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data, { sent: 1, failed: 0, quarantined: 0, of: 1, skipped: 0, excluded: 0 });

  const landed = path.join(s.boxRoot, "synced", "test-mac", "session1.jsonl");
  assert.equal(fs.readFileSync(landed, "utf8"), text);

  // Sending the same file again finds it already done: nothing re-sent.
  const again = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:import", { firstParty: true });
  assert.deepEqual(again.data, { sent: 0, failed: 0, quarantined: 0, of: 0, skipped: 1, excluded: 0 });

  // A person's own surface can never call it directly, and neither can an unrelated home module:
  // only core/sync itself or core/import (e2e's review — "module" alone was too wide).
  for (const caller of ["cli", "deck", "mcp", "module:some-home-module"]) {
    const denied = await s.macCall("sync.send", { files: [], mode: "once" }, caller, { firstParty: true });
    assert.equal(denied.error?.code, "denied", caller);
  }
  // What used to be checked here — a bare "module:import" with no meta.firstParty passed — is no
  // longer a spoof to test: af11226d moved meta.firstParty into the kernel itself (every call,
  // not only ctx.call's own wrapper), computed from the loader's real firstParty(dir) rule on
  // whichever module the caller's name resolves to (core/modules/modules.test.js's own "meta.
  // firstParty is set by the registry" case, line ~124, covers exactly this: a bare registry.call
  // claiming an existing first-party module's name gets firstParty: true, by design, since only
  // ctx.call — bound to the real calling module's own name — or vyred's own hardcoded internal
  // calls can ever produce a "module:" caller at all; nothing in core/daemon's router lets a
  // remote caller claim one (socketCaller's FORBIDDEN_LABEL). So "module:import" here answers as
  // the real, first-party core/import this harness's Mac genuinely runs — correctly, not a hole.
  // The actual threat the old comment named — "a home module can name itself import and pass" —
  // is still refused, because firstParty(dir) is the CLAIMED module's own directory: a module
  // installed into <root>/modules can never resolve there, whatever it calls itself (see
  // core/modules/modules.test.js's firstParty() cases for the shipped-vs-home split this rests
  // on). Nothing under core/sync or core/files needed to change for this.
});

test("sync.send: with the switch off, nothing is sent", async t => {
  const s = await pair(t, { router: true });
  const sessions = fakeSessions(s.macRoot);
  const file = path.join(sessions, "session2.jsonl");
  fs.writeFileSync(file, "hi");
  const r = await s.macCall("sync.send", { files: [{ path: file, rel: "session2.jsonl", bytes: 2, hash: hash("hi") }], mode: "once" }, "module:import", { firstParty: true });
  assert.equal(r.data.error?.code, "sync_disabled");
  assert.equal(r.data.sent, 0);
  assert.ok(!fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "session2.jsonl")));
});

test("sync.send: a file outside the device's own Claude Code folder is refused, even for an allowed caller (e2e review, arbitrary file read)", async t => {
  const s = await pair(t, { router: true });
  await s.boxCall("sync.consent", { machine: "test-mac", on: true }, "cli");
  fakeSessions(s.macRoot);
  // Anywhere else on the Mac, even a file that exists and is readable, is refused.
  const outside = path.join(s.macWork, "not-a-session.jsonl");
  fs.writeFileSync(outside, "hi");
  const r = await s.macCall("sync.send", { files: [{ path: outside, rel: "not-a-session.jsonl", bytes: 2, hash: hash("hi") }], mode: "once" }, "module:import", { firstParty: true });
  assert.deepEqual(r.data, { sent: 0, failed: 1, quarantined: 0, of: 1, skipped: 0, excluded: 0 });
  assert.ok(!fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "not-a-session.jsonl")));
});

test("sync.scan: sizes and file counts per project folder, exclusions honored, a stable planHash for what is included (Vyre Drive's what-to-sync picker)", async t => {
  const s = await pair(t, { router: true });
  const sessions = fakeSessions(s.macRoot);
  const projects = path.join(sessions, "projects");
  fs.mkdirSync(path.join(projects, "-home-alex-Work-northwind-bakery"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-home-alex-Work-northwind-bakery", "s1.jsonl"), "x".repeat(100));
  fs.writeFileSync(path.join(projects, "-home-alex-Work-northwind-bakery", "s2.jsonl"), "x".repeat(50));
  fs.mkdirSync(path.join(projects, "-tmp-scratch"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-tmp-scratch", "s1.jsonl"), "x".repeat(10));

  const r = await s.macCall("sync.scan", {}, "cli");
  assert.ok(!r.error, JSON.stringify(r.error));
  // project (Vyre Drive step 4): a proposed slug per folder, lib/project-id.js's own shape.
  assert.deepEqual(r.data.projects.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "-home-alex-Work-northwind-bakery", bytes: 150, files: 2, included: true, project: "home-alex-work-northwind-bakery" },
    { name: "-tmp-scratch", bytes: 10, files: 1, included: true, project: "tmp-scratch" },
  ]);
  assert.equal(r.data.total, 160);
  assert.deepEqual(r.data.excluded, []);
  const planAll = r.data.planHash;
  assert.match(planAll, /^[0-9a-f]{64}$/);

  // Leaving a folder out drops it from the total and flips its included flag, without touching
  // what is actually on disk (read-only: nothing is sent, nothing is deleted).
  const ex = await s.macCall("sync.scan", { exclude: ["-tmp-scratch"] }, "cli");
  assert.deepEqual(ex.data.excluded, ["-tmp-scratch"]);
  assert.equal(ex.data.total, 150);
  const scratch = ex.data.projects.find(p => p.name === "-tmp-scratch");
  assert.deepEqual(scratch, { name: "-tmp-scratch", bytes: 10, files: 1, included: false, project: "tmp-scratch" });
  assert.notEqual(ex.data.planHash, planAll, "a different set of exclusions is a different plan");
  assert.ok(fs.existsSync(path.join(projects, "-tmp-scratch", "s1.jsonl")), "sync.scan never touches a file");

  // The same exclusions again land on the same plan hash — it names a choice, not a moment in time.
  const again = await s.macCall("sync.scan", { exclude: ["-tmp-scratch"] }, "cli");
  assert.equal(again.data.planHash, ex.data.planHash);

  // A device with no projects folder yet answers empty, not an error.
  fs.rmSync(projects, { recursive: true, force: true });
  const none = await s.macCall("sync.scan", {}, "cli");
  assert.deepEqual(none.data.projects, []);
  assert.equal(none.data.total, 0);
});

test("sync.send: a file from a project the approved plan left out is refused, end to end, even passed in explicitly (reviewer's MEDIUM: exclusions enforced, not merely tagged)", async t => {
  const s = await pair(t, { router: true });
  const sessions = fakeSessions(s.macRoot);
  // Approved: only "kept" is included.
  await s.boxCall("sync.consent", { machine: "test-mac", on: true, planHash: "planX", included: ["kept"] }, "cli");

  const keptDir = path.join(sessions, "projects", "kept");
  const leftOutDir = path.join(sessions, "projects", "left-out");
  fs.mkdirSync(keptDir, { recursive: true });
  fs.mkdirSync(leftOutDir, { recursive: true });
  const keptFile = path.join(keptDir, "s1.jsonl");
  const leftOutFile = path.join(leftOutDir, "s1.jsonl");
  fs.writeFileSync(keptFile, "kept text");
  fs.writeFileSync(leftOutFile, "left out text");

  const r = await s.macCall("sync.send", { files: [
    { path: keptFile, rel: "projects/kept/s1.jsonl", bytes: 9, hash: hash("kept text") },
    { path: leftOutFile, rel: "projects/left-out/s1.jsonl", bytes: 14, hash: hash("left out text") },
  ], mode: "once" }, "module:import", { firstParty: true });
  assert.ok(!r.error, JSON.stringify(r.error));
  // The excluded file is never attempted at all (sync.upload.plan already said so): sent counts
  // the kept file only, and excluded counts the other — not failed, and not silently dropped.
  assert.deepEqual(r.data, { sent: 1, failed: 0, quarantined: 0, of: 1, skipped: 0, excluded: 1 });
  assert.ok(fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "projects", "kept", "s1.jsonl")));
  assert.ok(!fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "projects", "left-out", "s1.jsonl")));

  // Even if a caller skips sync.upload.plan and asks sync.upload.start for the excluded file
  // directly, the box refuses it: enforcement is not merely advisory reporting.
  const direct = await s.boxCall("sync.upload.start", { path: "projects/left-out/s1.jsonl", bytes: 14, hash: hash("left out text") }, "tailnet:owner", { peer: { stableId: "nMAC" } });
  assert.equal(direct.error?.code, "excluded");
});
