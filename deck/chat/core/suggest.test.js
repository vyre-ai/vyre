// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryInput, tokenBefore, suggestRows, applySuggestion, pickedInput } from "./suggest.js";

test("suggest: the query names the chat surface and keeps the caret inside the text", () => {
  assert.deepEqual(queryInput("ask @ju", 7), { text: "ask @ju", cursor: 7, surface: "chat" });
  assert.equal(queryInput("hi", 99).cursor, 2);
  assert.deepEqual(tokenBefore("ask @ju now", 7), { start: 4, end: 7, token: "@ju" });
});

test("suggest: only well-formed rows of the kinds chat shows, at most the limit", () => {
  const rows = suggestRows({ items: [
    { kind: "mention", sub: "agent", label: "juno", insert: "@juno", source: "agents", id: "juno", score: 0.9 },
    { kind: "time", label: "in 2 h", insert: "at 3pm", source: "planner", id: "t1" },
    { kind: "entity", label: "Northwind Bakery", insert: "Northwind Bakery", source: "memory", id: "e1" },
    { kind: "mention", label: "", insert: "@x", source: "agents", id: "x" },
    { kind: "mention", label: "kit", insert: 5, source: "agents", id: "kit" },
  ] }, 5);
  assert.deepEqual(rows.map(r => r.id), ["juno", "e1"]);
  assert.equal(suggestRows({ items: Array.from({ length: 20 }, (_, n) => ({ kind: "phrase", label: "p" + n, insert: "p" + n, source: "s", id: String(n) })) }, 3).length, 3);
  assert.deepEqual(suggestRows(null), []);
});

test("suggest: a pick replaces the token at the caret, adds one space, and tells picked its kind, source and id", () => {
  const row = { kind: "mention", label: "juno", insert: "@juno", source: "agents", id: "juno", score: 1 };
  assert.deepEqual(applySuggestion("ask @ju", 7, row), { text: "ask @juno ", caret: 10 });
  assert.deepEqual(applySuggestion("ask @ju about it", 7, row), { text: "ask @juno about it", caret: 10 });
  assert.deepEqual(applySuggestion("North", 5, { insert: "Northwind Bakery" }), { text: "Northwind Bakery ", caret: 17 });
  assert.deepEqual(pickedInput(row), { kind: "mention", source: "agents", id: "juno" });
});
