// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupLine, whenLine, vaultBackupLines } from "./backups-model.js";

test("a Space nobody turned backups on for says so plainly, by name", () => {
  assert.equal(backupLine({ space: "spc_a", name: "Harbor", home: false, enrolled: false, last: null }), "Space Harbor isn't backed up: its owner hasn't turned on backups.");
  assert.match(backupLine({ space: "spc_b", name: "this box's own Space", home: true, enrolled: false, last: null }), /Your own Space isn't backed up yet/);
  assert.equal(backupLine({ space: "spc_a", name: "Harbor", home: false, enrolled: true, last: 1 }), "Backed up with this box's backups");
});

test("when it was last written reads in a few words", () => {
  const now = 10_000_000_000;
  assert.deepEqual([null, now - 30_000, now - 20 * 60_000, now - 3 * 3_600_000, now - 2 * 86_400_000].map(t => whenLine(t, now)), ["Waiting for the first backup", "Just now", "20 minutes ago", "3 hours ago", "2 days ago"]);
});

test("the vault's own backup reads as two plain lines: the last backup and the last drill", () => {
  const now = 10_000_000_000;
  const off = vaultBackupLines({ enrolled: false, last: null, drill: null, keep: 14 }, now);
  assert.match(off.backup, /^Not on\./);
  assert.equal(off.warn, true);
  const on = vaultBackupLines({ enrolled: true, last: { at: now - 3 * 3_600_000, items: 12 }, drill: null, keep: 14 }, now);
  assert.equal(on.backup, "Last backup 3 hours ago, 12 items. The newest 14 are kept.");
  assert.match(on.drill, /Not tried yet/);
  const ok = vaultBackupLines({ enrolled: true, last: { at: now - 60_000, items: 1 }, drill: { at: now - 60_000, ok: true, note: "1 of 1 items match the live vault" }, keep: 14 }, now);
  assert.match(ok.drill, /it worked/);
  assert.equal(ok.warn, false);
  const bad = vaultBackupLines({ enrolled: true, last: { at: now, items: 2 }, drill: { at: now, ok: false, note: "1 missing, 0 different" }, keep: 14 }, now);
  assert.match(bad.drill, /did NOT match/);
  assert.equal(bad.warn, true);
});
