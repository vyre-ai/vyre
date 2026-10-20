// @ts-check
// The Chat list's run lookup per chat (chat-runs.js): an answer gives the runs, a refusal gives none, and a lookup that never answers gives none once its budget has passed.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNS_BUDGET_MS, chatRuns } from "./chat-runs.js";

test("chat runs: the answer's runs, and none for a refusal or a malformed answer", async () => {
  const runs = [{ provider: "claude", last_line: "Draft ready", last: 5 }];
  assert.deepEqual(await chatRuns(async (tool, input) => (tool === "threads.of-chat" && input.chat === "chat_a" ? { data: { runs } } : null), "chat_a"), runs);
  assert.deepEqual(await chatRuns(async () => { throw new Error("denied"); }, "chat_a"), []);
  assert.deepEqual(await chatRuns(() => { throw new Error("sync throw"); }, "chat_a"), []);
  assert.deepEqual(await chatRuns(async () => ({ data: { runs: "x" } }), "chat_a"), []);
});

test("chat runs: a lookup that never answers gives none after the budget, so the list is not held", async () => {
  const t0 = Date.now();
  assert.deepEqual(await chatRuns(() => new Promise(() => {}), "chat_slow", 200), []);
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 1500, `answered in ${took} ms`);
  assert.ok(RUNS_BUDGET_MS > 0 && RUNS_BUDGET_MS <= 2000, "the default budget is short");
});
