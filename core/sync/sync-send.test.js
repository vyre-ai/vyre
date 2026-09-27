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

test("sync.send: a device's own file reaches the box over the real link, chunked route included", async t => {
  const s = await pair(t, { router: true });
  await s.boxCall("sync.consent", { machine: "test-mac", on: true }, "cli");

  const text = "line one\nline two\n".repeat(200); // a few chunks' worth, at a small SEND_CHUNK in tests would help, but 1 MB default covers this in one
  const file = path.join(s.macWork, "session1.jsonl");
  fs.writeFileSync(file, text);
  const h = hash(text);

  const r = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:test");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data, { sent: 1, failed: 0, quarantined: 0, of: 1, skipped: 0 });

  const landed = path.join(s.boxRoot, "synced", "test-mac", "session1.jsonl");
  assert.equal(fs.readFileSync(landed, "utf8"), text);

  // Sending the same file again finds it already done: nothing re-sent.
  const again = await s.macCall("sync.send", { files: [{ path: file, rel: "session1.jsonl", bytes: text.length, hash: h }], mode: "once" }, "module:test");
  assert.deepEqual(again.data, { sent: 0, failed: 0, quarantined: 0, of: 0, skipped: 1 });

  // A person's own surface can never call it directly: only a module (import.start's door).
  for (const caller of ["cli", "deck", "mcp"]) {
    const denied = await s.macCall("sync.send", { files: [], mode: "once" }, caller);
    assert.equal(denied.error?.code, "denied", caller);
  }
});

test("sync.send: with the switch off, nothing is sent", async t => {
  const s = await pair(t, { router: true });
  const file = path.join(s.macWork, "session2.jsonl");
  fs.writeFileSync(file, "hi");
  const r = await s.macCall("sync.send", { files: [{ path: file, rel: "session2.jsonl", bytes: 2, hash: hash("hi") }], mode: "once" }, "module:test");
  assert.equal(r.data.error?.code, "sync_disabled");
  assert.equal(r.data.sent, 0);
  assert.ok(!fs.existsSync(path.join(s.boxRoot, "synced", "test-mac", "session2.jsonl")));
});
