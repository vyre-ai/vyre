// @ts-check
// sync.send end to end: a real Mac and box, paired over the simulated tailnet (test/link-harness.js),
// with the daemon's real router so the raw chunk route (POST /v1/sync/upload/<id>) is reached too,
// not only the tool logic (core/sync/sync.test.js covers that directly and more thoroughly).

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pair } from "../../test/link-harness.js";
import { tempHome } from "../../test/helpers.js";

const hash = s => crypto.createHash("sha256").update(s).digest("hex");

/** sync.send reads only from the person's own Claude Code folder: a fake one, never the real ~/.claude. */
function fakeSessions(t) {
  const dir = tempHome(t); // its own temp folder is enough; we only need it off the real home
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  return dir;
}

test("sync.send: a device's own file reaches the box over the real link, chunked route included", async t => {
  const s = await pair(t, { router: true });
  await s.boxCall("sync.consent", { machine: "test-mac", on: true }, "cli");
  const sessions = fakeSessions(t);

  const text = "line one\nline two\n".repeat(200); // a few chunks' worth, at a small SEND_CHUNK in tests would help, but 1 MB default covers this in one
  const file = path.join(sessions, "session1.jsonl");
  fs.writeFileSync(file, text);
  const h = hash(text);

  // memory-iq's import module is the door; "module:import" stands in for it, with the firstParty
  // flag the loader itself stamps on a module-to-module call (ctx.call never lets a module set
  // this — see core/sync/sync.test.js for the "label alone is not enough" spoof case).
  const r = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:import", { firstParty: true });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data, { sent: 1, failed: 0, quarantined: 0, of: 1, skipped: 0 });

  const landed = path.join(s.boxRoot, "synced", "test-mac", "session1.jsonl");
  assert.equal(fs.readFileSync(landed, "utf8"), text);

  // Sending the same file again finds it already done: nothing re-sent.
  const again = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:import", { firstParty: true });
  assert.deepEqual(again.data, { sent: 0, failed: 0, quarantined: 0, of: 0, skipped: 1 });

  // A person's own surface can never call it directly, and neither can an unrelated home module:
  // only core/sync itself or core/import (e2e's review — "module" alone was too wide).
  for (const caller of ["cli", "deck", "mcp", "module:some-home-module"]) {
    const denied = await s.macCall("sync.send", { files: [], mode: "once" }, caller, { firstParty: true });
    assert.equal(denied.error?.code, "denied", caller);
  }
  // The label alone, without the loader's own firstParty stamp, is not enough either (reviewer's
  // LOW): a home module cannot simply name itself "import" and pass.
  const spoofed = await s.macCall("sync.send", { files: [], mode: "once" }, "module:import");
  assert.equal(spoofed.error?.code, "denied");
});

test("sync.send: with the switch off, nothing is sent", async t => {
  const s = await pair(t, { router: true });
  const sessions = fakeSessions(t);
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
  fakeSessions(t);
  // Anywhere else on the Mac, even a file that exists and is readable, is refused.
  const outside = path.join(s.macWork, "not-a-session.jsonl");
  fs.writeFileSync(outside, "hi");
  const r = await s.macCall("sync.send", { files: [{ path: outside, rel: "not-a-session.jsonl", bytes: 2, hash: hash("hi") }], mode: "once" }, "module:import", { firstParty: true });
  assert.deepEqual(r.data, { sent: 0, failed: 1, quarantined: 0, of: 1, skipped: 0 });
  assert.ok(!fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "not-a-session.jsonl")));
});

test("sync.scan: sizes and file counts per project folder, exclusions honored, a stable planHash for what is included (Vyre Drive's what-to-sync picker)", async t => {
  const s = await pair(t, { router: true });
  const sessions = fakeSessions(t);
  const projects = path.join(sessions, "projects");
  fs.mkdirSync(path.join(projects, "-home-alex-Work-northwind-bakery"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-home-alex-Work-northwind-bakery", "s1.jsonl"), "x".repeat(100));
  fs.writeFileSync(path.join(projects, "-home-alex-Work-northwind-bakery", "s2.jsonl"), "x".repeat(50));
  fs.mkdirSync(path.join(projects, "-tmp-scratch"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-tmp-scratch", "s1.jsonl"), "x".repeat(10));

  const r = await s.macCall("sync.scan", {}, "cli");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data.projects.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "-home-alex-Work-northwind-bakery", bytes: 150, files: 2, included: true },
    { name: "-tmp-scratch", bytes: 10, files: 1, included: true },
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
  assert.deepEqual(scratch, { name: "-tmp-scratch", bytes: 10, files: 1, included: false });
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
