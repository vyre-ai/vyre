// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupLine, whenLine } from "./backups-model.js";

test("a Space nobody turned backups on for says so plainly, by name", () => {
  assert.equal(backupLine({ space: "spc_a", name: "Harbor", home: false, enrolled: false, last: null }), "Space Harbor isn't backed up: its owner hasn't turned on backups.");
  assert.match(backupLine({ space: "spc_b", name: "this box's own Space", home: true, enrolled: false, last: null }), /Your own Space isn't backed up yet/);
  assert.equal(backupLine({ space: "spc_a", name: "Harbor", home: false, enrolled: true, last: 1 }), "Backed up with this box's backups");
});

test("when it was last written reads in a few words", () => {
  const now = 10_000_000_000;
  assert.deepEqual([null, now - 30_000, now - 20 * 60_000, now - 3 * 3_600_000, now - 2 * 86_400_000].map(t => whenLine(t, now)), ["Waiting for the first backup", "Just now", "20 minutes ago", "3 hours ago", "2 days ago"]);
});
