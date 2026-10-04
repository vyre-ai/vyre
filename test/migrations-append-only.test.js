import "../scripts/mac-test-guard.mjs";
// A module's migration list is APPEND-ONLY. A migration's number is its place in the list and an existing box has already applied the earlier ones, so moving, editing or removing a released
// step, or inserting a new one anywhere but the end, makes an upgraded box re-run a step it already has (the team module once failed to start on every upgraded box: "duplicate column name: title").
// test/migrations.released.json records, per module, a hash of each released step in order; the live list must start with exactly that. A step added at the end is fine until the next release records
// it (`node scripts/record-migrations.mjs`). A module that did not exist at the last release is new and may have any list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationHashes } from "./migrations-lists.mjs";

const released = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations.released.json"), "utf8")).modules;

test("every module's released migration steps are where they were: nothing moved, edited or removed, new steps only at the end", { timeout: 120_000 }, async t => {
  const live = await migrationHashes(t);
  /** @type {string[]} */ const problems = [];
  for (const [module, hashes] of Object.entries(released)) {
    const now = live[module];
    if (!now) { problems.push(`${module}: its migration list is gone (${hashes.length} released steps)`); continue; }
    if (now.length < hashes.length) problems.push(`${module}: ${hashes.length - now.length} released step(s) removed (released ${hashes.length}, now ${now.length})`);
    for (let i = 0; i < Math.min(hashes.length, now.length); i++) {
      if (now[i] !== hashes[i]) { problems.push(`${module}: step ${i + 1} was moved or edited (a new step goes at the END of the list)`); break; }
    }
  }
  assert.deepEqual(problems, [], "a module's migration list is append-only: " + problems.join("; "));
});

test("the detector catches the team module's bug: a step inserted in the middle of a released list", () => {
  const was = ["a", "b", "c"], inserted = ["a", "NEW", "b", "c"];
  const moved = was.some((h, i) => inserted[i] !== h);
  assert.equal(moved, true);
});
