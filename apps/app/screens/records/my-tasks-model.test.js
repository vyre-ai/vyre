// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MY_GROUPS, dueFirst, stateWords } from "./my-tasks-model.js";

test("the three groups are the three slots, in order", () => {
  assert.deepEqual(MY_GROUPS.map((g) => g.slot), ["assigned", "reviewing", "approving"]);
  assert.deepEqual(MY_GROUPS[1].states, ["in_review"]);
  assert.deepEqual(MY_GROUPS[2].states, ["needs_check"]);
});

test("tasks with a due date come first, soonest first", () => {
  assert.deepEqual(dueFirst([{ id: "a" }, { id: "b", due: 200 }, { id: "c", due: 100 }]).map((x) => x.id), ["c", "b", "a"]);
});

test("a state reads in plain words", () => {
  assert.equal(stateWords("needs_check"), "Awaiting approval");
  assert.equal(stateWords("odd"), "odd");
});
