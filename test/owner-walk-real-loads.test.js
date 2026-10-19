// @ts-check
// The owner-walk script parses and loads, so a typo in it cannot spend a release walk (a real box and a real browser, about an hour). Importing it starts nothing: no browser, no box, no read of the environment or the model key.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("scripts/lib/proof/owner-walk-real.mjs loads and exports its walk as a function", async () => {
  const m = await import("../scripts/lib/proof/owner-walk-real.mjs");
  assert.deepEqual(Object.keys(m), ["ownerWalkReal"]);
  assert.equal(typeof m.ownerWalkReal, "function");
});
