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

import { agentCards, workingCount } from "./home-model.js";

test("the agent row puts the assistant first, then live agents, and counts who is working", () => {
  const cards = agentCards([{ name: "kit", doing: "idle" }, { name: "juno", doing: "working" }, { name: "alex", kind: "assistant", doing: "idle" }, { name: "sam", doing: "waiting on your answer" }, null, { nope: 1 }]);
  assert.deepEqual(cards.map((c) => c.name), ["alex", "juno", "sam", "kit"]);
  assert.deepEqual(cards.map((c) => [c.live, c.needsYou]), [[false, false], [true, false], [true, true], [false, false]]);
  assert.equal(workingCount(cards), 2);
  assert.deepEqual(agentCards(undefined), []);
});

import { todayStrip } from "./home-model.js";

test("the Today strip is in time order, marks what has passed and finds the next", () => {
  const s = todayStrip([{ id: "c", at: 300, title: "C" }, { id: "a", at: 100, title: "A" }, { id: "b", at: 200, title: "B" }, { id: "d", at: 400, title: "D" }], 150, 3);
  assert.deepEqual(s.rows.map((r) => [r.id, r.past]), [["a", true], ["b", false], ["c", false]]);
  assert.deepEqual([s.nextId, s.more], ["b", 1]);
  assert.deepEqual(todayStrip(undefined, 0), { rows: [], nextId: null, more: 0 });
});
