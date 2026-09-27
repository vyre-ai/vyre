// @ts-check
// The memory line of `vyre status`: what memory knows about the user and the model pass's spend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLine } from "./daemon.js";

test("vyre status: the memory line", () => {
  const model = { on: true, today_usd: 0.02, cap_usd: 0.05, calls_today: 2, cues_waiting: 40, last: null };
  assert.equal(memoryLine({ facts: 430, current: 412, model }), "memory   412 facts about you, model pass $0.02 of $0.05 today");
  assert.equal(memoryLine({ facts: 1, current: 1 }), "memory   1 fact about you", "no model field yet: facts only");
  assert.equal(memoryLine({ facts: 12 }), "memory   12 facts about you");
  assert.equal(memoryLine({ current: 3, model: { on: false, today_usd: 0, cap_usd: 0.05 } }), "memory   3 facts about you, model pass off");
  assert.equal(memoryLine({ current: 0, model: { on: true, today_usd: 0, cap_usd: 0.05 } }), "memory   0 facts about you, model pass $0.00 of $0.05 today");
  assert.equal(memoryLine({ current: 5, model: { on: true } }), "memory   5 facts about you", "a model object without numbers says nothing");
  assert.equal(memoryLine({ current: 9, model: { on: true, today_usd: 0.25, cap_usd: 0.25, backfill_usd: 1.1, backfill_cap_usd: 2, waiting_turns: 340 } }),
    "memory   9 facts about you, model pass $0.25 of $0.25 today, backfill $1.10 of $2.00, 340 turns to read");
  for (const bad of [undefined, null, "x", {}, { facts: "many" }]) assert.equal(memoryLine(bad), null);
});
