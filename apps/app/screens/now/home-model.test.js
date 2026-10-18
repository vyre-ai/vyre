import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { greeting, partOfDay, summary, dateLine } from "./home-model.js";

test("the greeting follows the local hour and uses the first name", () => {
  assert.deepEqual([5, 11, 12, 16, 17, 21, 22, 4].map(partOfDay), ["morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
  assert.equal(greeting(9, "Alex Rivera"), "Good morning, Alex.");
  assert.equal(greeting(2, "Alex"), "Still up, Alex.");
  assert.equal(greeting(14), "Good afternoon.");
});

test("the summary names only what is there", () => {
  assert.equal(summary({}), "Nothing needs you right now.");
  assert.equal(summary({ waiting: 1, working: 2, today: 3 }), "1 thing needs you, 2 agents are working, 3 on today.");
  assert.equal(summary({ working: 1 }), "1 agent is working.");
});

test("the date line is the weekday and day", () => {
  assert.equal(dateLine(Date.UTC(2026, 9, 18, 12), "UTC"), "Sunday, 18 October");
});
