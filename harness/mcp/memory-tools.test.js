// @ts-check
// The five memory tools' names and how each maps onto a vyred tool (plan 3.1A).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIASES, REPLACED } from "./memory-tools.js";

test("memory tools: search, remember and correct map onto memory.retrieve, memory.write and memory.heard", () => {
  assert.deepEqual(Object.keys(ALIASES).sort(), ["memory_correct", "memory_remember", "memory_search"]);
  assert.deepEqual([...REPLACED].sort(), ["memory.heard", "memory.retrieve", "memory.write"]);
  assert.deepEqual(ALIASES.memory_search.map({ query: "hosting", limit: 4 }, {}), { question: "hosting", k: 4 });
  assert.deepEqual(ALIASES.memory_correct.map({ action: "wrong", answer_id: "a1", from_turn: { seq: 3 } }, {}), { action: "wrong", from_turn: { seq: 3 }, answer: "a1" });
});

test("memory_remember: kind defaults to note, the project to the agent's only one, and never to a list", () => {
  const map = ALIASES.memory_remember.map;
  assert.deepEqual(map({ text: "x" }, { VYRE_PROJECTS: "harlow" }), { kind: "note", text: "x", project: "harlow" });
  assert.equal(map({ text: "x" }, { VYRE_PROJECTS: "harlow,northwind" }).project, undefined);
  assert.equal(map({ text: "x" }, { VYRE_PROJECTS: "*" }).project, undefined);
  assert.equal(map({ text: "x", project: "northwind", kind: "decision" }, { VYRE_PROJECTS: "harlow" }).project, "northwind");
});
