import "../scripts/mac-test-guard.mjs";
// test/known-red.json lists the test files that are red today, each with its owner, so the node job is green except for a new failure. The list only shrinks: its size is frozen here,
// lower MAX when an owner removes a file, never raise it. A new red file is a new failure, not a new entry.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX = 58;
const list = JSON.parse(fs.readFileSync(path.join(REPO, "test", "known-red.json"), "utf8"));

test("the known-red list only shrinks, and every entry names a test file and an owner", () => {
  assert.ok(Object.keys(list).length <= MAX, `known-red grew to ${Object.keys(list).length}; the limit is ${MAX}`);
  for (const [f, v] of Object.entries(list)) {
    assert.match(f, /\.test\.js$/, `${f} is not a test file`);
    assert.match(String(v.owner), /^[a-z][a-z0-9-]+$/, `${f} has no owner`);
  }
});
