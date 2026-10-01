// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerRows, chipWord } from "./answer-with.js";

const LIST = [
  { id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }, { id: "c2", label: "Work", signed_in: true }], models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }, { id: "x", label: "Extra" }] },
  { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true, plan: "ChatGPT Plus" }], models: [] },
  { id: "grok", label: "Grok", accounts: [{ id: "g1", label: "xAI", signed_in: false }], models: [] },
  { id: "openrouter", label: "OpenRouter", accounts: [], models: [] },
];

test("only accounts that can answer are rows: signed in, or Claude with none; plan and up to three models in the line", () => {
  const rows = answerRows(LIST, { provider: "claude" });
  assert.deepEqual(rows.map(r => [r.provider, r.account, r.label]), [["claude", "c1", "Personal"], ["claude", "c2", "Work"], ["codex", "x1", "OpenAI"]]);
  assert.equal(rows[0].sub, "Opus, Sonnet, Haiku");
  assert.equal(rows[2].sub, "ChatGPT Plus");
  assert.deepEqual(answerRows([{ id: "claude", accounts: [] }], {}).map(r => [r.provider, r.account]), [["claude", null]]);
});

test("exactly one row is now: the thread's account when it says, else the provider's default", () => {
  assert.deepEqual(answerRows(LIST, { provider: "claude", account: "c2" }).map(r => r.now), [false, true, false]);
  assert.deepEqual(answerRows(LIST, { provider: "claude" }).map(r => r.now), [true, false, false]);
  assert.deepEqual(answerRows(LIST, { provider: "codex" }).map(r => r.now), [false, false, true]);
  assert.deepEqual(answerRows(LIST, {}).map(r => r.now), [false, false, false]);
});

test("the chip names the account only when the provider has several; otherwise the provider", () => {
  const rows = answerRows(LIST, { provider: "claude", account: "c2" });
  assert.equal(chipWord(rows, "claude", "Claude"), "Work");
  assert.equal(chipWord(answerRows(LIST, { provider: "codex" }), "codex", "Codex"), "Codex");
});
