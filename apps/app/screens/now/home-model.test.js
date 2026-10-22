import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greeting, homeName, partOfDay, summary, dateLine, agentCards, workingCount, askChips, isEngineer, isQuietDay, QUIET_LINE, mention } from "./home-model.js";

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

test("the agent row puts the assistant first, then live agents, and counts who is working", () => {
  const cards = agentCards([{ name: "kit", doing: "idle" }, { name: "juno", doing: "working" }, { name: "alex", kind: "assistant", doing: "idle" }, { name: "sam", doing: "waiting on your answer" }, null, { nope: 1 }]);
  assert.deepEqual(cards.map((c) => c.name), ["alex", "juno", "sam", "kit"]);
  assert.deepEqual(cards.map((c) => [c.live, c.needsYou]), [[false, false], [true, false], [true, true], [false, false]]);
  assert.equal(workingCount(cards), 2);
  assert.deepEqual(agentCards(undefined), []);
});

test("the Engineer is never a chip, in any case", () => {
  const cards = agentCards([{ name: "kit", doing: "idle" }, { name: "Engineer", doing: "working" }, { name: "alex", kind: "assistant", doing: "idle" }, { name: "engineer", doing: "idle" }]);
  assert.equal(isEngineer("Engineer") && isEngineer("engineer") && !isEngineer("kit"), true);
  assert.equal(cards.some((c) => /engineer/i.test(c.name)), true);
  assert.deepEqual(askChips(cards).map((c) => c.name), ["alex", "kit"]);
  assert.deepEqual(askChips(undefined), []);
});

test("a quiet day is one line, and a day with anything in a section is not", () => {
  assert.equal(QUIET_LINE, "All clear. Nothing needs you today.");
  assert.equal(isQuietDay({}), true);
  assert.equal(isQuietDay({ needs: 0, doing: 0, today: 0, recent: 0 }), true);
  assert.equal(isQuietDay({ needs: 1 }), false);
  assert.equal(isQuietDay({ doing: 1 }), false);
  assert.equal(isQuietDay({ today: 2 }), false);
  assert.equal(isQuietDay({ recent: 1 }), false);
});

test("a chip writes @name into the ask field", () => {
  assert.equal(mention("", "kit"), "@kit ");
  assert.equal(mention("@jun", "juno"), "@juno ");
  assert.equal(mention("@jun hello", "juno"), "@juno hello");
  assert.equal(mention("remind me", "kit"), "@kit remind me");
});

test("Home draws the quiet line and does not stack the old empty states", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const read = (name) => readFileSync(join(dir, name), "utf8");
  const screen = ["NowScreen.tsx", "HomeBody.tsx", "HomeToday.tsx", "HomeRecent.tsx", "HomeTasks.tsx", "AskDock.tsx", "HomeHeader.tsx", "HomeWork.tsx", "HomeAgents.tsx"].map(read).join("\n");
  assert.match(screen, /QUIET_LINE/);
  assert.match(read("HomeAgents.tsx"), /askChips/);
  assert.match(read("AskDock.tsx"), /Ask anything, or @ an agent/);
  assert.match(read("AskDock.tsx"), /icon="send"/);
  assert.match(read("HomeTasks.tsx"), /Add a task, like remind me at 7/);
  assert.match(read("HomeTasks.tsx"), /icon="plus"/);
  assert.doesNotMatch(screen, /Nothing needs you|Nobody is working right now|Nothing today|Nothing this week|Nothing has happened yet|Ask your assistant/);
  assert.doesNotMatch(read("NowScreen.tsx"), /dock=/);
  assert.doesNotMatch(read("HomeTasks.tsx"), /"Add"/);
});

