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
