import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// real-model.ts is TypeScript: these run where the test runner strips types (testbox, node 22.23+); elsewhere they skip.
const strip = Boolean(/** @type {any} */ (process.features).typescript);
const m = strip ? await import("./real-model.ts") : null;
const skip = !strip;

test("a wait is named in seconds under a minute and in whole minutes after", { skip }, () => {
  assert.equal(m.waitWords(30), "30 seconds");
  assert.equal(m.waitWords(1), "1 second");
  assert.equal(m.waitWords(60), "1 minute");
  assert.equal(m.waitWords(61), "2 minutes");
  assert.equal(m.waitWords(900), "15 minutes");
});

test("the personal vault's refusals are our own sentences, by code", { skip }, () => {
  assert.match(m.personalUnlockRefusal("wrong_password"), /not the password/);
  assert.match(m.personalUnlockRefusal("throttled", { retry_after_s: 120 }), /Try again in 2 minutes/);
  assert.match(m.personalUnlockRefusal("no_secret_key"), /recovery kit/);
  assert.equal(m.personalUnlockRefusal("something_new"), "The personal vault did not open. Nothing was changed.");
  assert.equal(m.personalUnlockRefusal(undefined), "The personal vault did not open. Nothing was changed.");
});
