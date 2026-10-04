// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureLine, settledLines } from "./gate-lines.js";

test("a failed send says whether it may have gone out", () => {
  assert.match(failureLine("timeout", "maybe"), /may have gone out anyway.*Check the app/);
  assert.match(failureLine("refused", "no"), /did not go out/);
  assert.match(failureLine("refused", undefined), /still held/);
  assert.match(failureLine("", null), /the sender failed/);
});

test("a settled item says where it went, and why it went without asking", () => {
  assert.deepEqual(settledLines({ state: "sent", to: ["a@b.co"], said: "i1", diff: { removed: [], added: [] } }), ["To a@b.co", "You said to, so it went without asking."]);
  assert.deepEqual(settledLines({ state: "sent", to: ["a@b.co"], said: null, diff: { removed: ["x"], added: [] } }), ["To a@b.co", "You changed it before it went. What went out is what you saw."]);
  assert.deepEqual(settledLines({ state: "rejected", to: ["a@b.co"] }), ["Nothing was sent."]);
  assert.deepEqual(settledLines({ state: "sent" }), []);
});
