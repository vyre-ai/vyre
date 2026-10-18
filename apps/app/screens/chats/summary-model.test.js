// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { summaryByAgent } from "./summary-model.js";

test("work.chat.summary's agents, the pinned one too, by name: count, latest, live, needs you", () => {
  const m = summaryByAgent({
    pinned: [{ kind: "agent", agent: "assistant", name: "Assistant", threads: 3, latest: { thread: "c1", title: "Spring launch email", last_active: 50, state: "idle" }, live: null, needs_you: false }],
    agents: [{ kind: "agent", agent: "computer", name: "Computer", threads: 1, latest: { thread: "c2", title: "Book the photographer", last_active: 40, state: "needs_you" }, live: { thread: "c2", title: "Book the photographer", needs_you: true }, needs_you: true }, { kind: "flow", name: "no" }, null],
    people: [], groups: [], flows: [],
  });
  assert.deepEqual(m.get("assistant"), { count: 3, latest: "Spring launch email", at: 50 });
  assert.deepEqual(m.get("computer"), { count: 1, latest: "Book the photographer", at: 40, live: "Book the photographer", needs: true });
  assert.equal(m.size, 2);
});

test("no answer, or nothing useful, is an empty map", () => {
  assert.equal(summaryByAgent(null).size, 0);
  assert.equal(summaryByAgent({ agents: "x" }).size, 0);
});
