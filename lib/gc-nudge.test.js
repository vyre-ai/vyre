import { test } from "node:test";
import assert from "node:assert/strict";
import { collectIfHeavy } from "../lib/gc-nudge.js";

test("collectIfHeavy: sets a floor first, then collects only after real growth, and not twice in a second", () => {
  assert.equal(collectIfHeavy(), false);
  assert.equal(collectIfHeavy(), false);
  const keep = [];
  for (let i = 0; i < 40; i++) keep.push(new Array(150_000).fill(i));
  assert.equal(collectIfHeavy(), true);
  assert.equal(collectIfHeavy(), false);
  assert.ok(keep.length === 40);
});
