import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedWait } from "./bounded.js";

test("boundedWait: settles in time -> false; a hung promise -> true after the bound, never blocking", async () => {
  assert.equal(await boundedWait([Promise.resolve(1), new Promise(r => setTimeout(r, 10))], 500), false);
  assert.equal(await boundedWait([], 500), false);
  const t0 = Date.now();
  assert.equal(await boundedWait([new Promise(() => {})], 60), true);
  assert.ok(Date.now() - t0 < 1000);
});
