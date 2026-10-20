import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { greeting, homeName, partOfDay, summary, dateLine } from "./home-model.js";

test("the greeting follows the local hour and uses the first name", () => {
  assert.deepEqual([5, 11, 12, 16, 17, 21, 22, 4].map(partOfDay), ["morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
  assert.equal(greeting(9, "Alex Rivera"), "Good morning, Alex.");
  assert.equal(greeting(2, "Alex"), "Still up, Alex.");
  assert.equal(greeting(14), "Good afternoon.");
});

test("Home greets the display name, else the username, never You or an id", () => {
  assert.equal(homeName({ label: "Sam Rivera", name: "sam" }), "Sam Rivera");
  assert.equal(homeName({ name: "sam" }), "sam");
  assert.equal(homeName({ label: "You", name: "sam" }), "sam");
  assert.equal(homeName({ label: "You" }), "");
  assert.equal(homeName({ name: "per_pbiglgp6ji6jzrnbskpuzw77np" }), "");
  assert.equal(homeName(null), "");
  assert.equal(greeting(3, homeName({ label: "Sam Rivera" })), "Still up, Sam.");
});

test("the summary names only what is there", () => {
  assert.equal(summary({}), "All quiet for now.");
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

