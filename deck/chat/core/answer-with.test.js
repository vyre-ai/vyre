// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerRows, chipWord, accountAtStart, accountToken, isModel, chipLine, runsOn } from "./answer-with.js";

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

const NAME = p => ({ claude: "Claude", codex: "Codex", grok: "Grok" })[p] || p;
test("@codex at the very start asks that provider for one turn; a provider with several accounts is addressed by Provider-label", () => {
  const rows = answerRows(LIST, { provider: "claude" });
  assert.deepEqual(accountAtStart("@codex make an image", rows, NAME), { mention: { kind: "account", id: "codex", name: "Codex" }, token: "codex" });
  assert.deepEqual(accountAtStart("@Codex", rows, NAME)?.mention.id, "codex");
  assert.equal(accountToken(rows[1], rows, NAME), "Claude-Work");
  assert.deepEqual(accountAtStart("@claude-work hello", rows, NAME)?.mention, { kind: "account", id: "claude:c2", name: "Claude-Work" });
  assert.equal(accountAtStart("@claude hello", rows, NAME)?.mention.id, "claude", "the bare provider is the provider's own pick");
});

test("anything else is not an account: a teammate role, a mid-sentence @, an email, an unsigned provider", () => {
  const rows = answerRows(LIST, {});
  for (const t of ["@design fix it", "ask @codex", "me@codex.com", "@grok hi", "@", "codex"]) assert.equal(accountAtStart(t, rows, NAME), null, t);
});

test("each account row carries its models for the menu, and the session's model matches by id or alias", () => {
  const rows = answerRows(LIST, { provider: "claude" });
  assert.deepEqual(rows[0].models.map(m => m.id), ["opus", "sonnet", "haiku", "x"]);
  assert.deepEqual(rows[2].models, []);
  assert.equal(isModel("claude-opus-4-5", "opus"), true);
  assert.equal(isModel("opus", "opus"), true);
  assert.equal(isModel("claude-sonnet-4-5", "opus"), false);
  assert.equal(isModel(null, "opus"), false);
});

test("the chip line: who, then model and effort together", () => {
  assert.equal(chipLine("Codex", "GPT-5", "high"), "Codex · GPT-5 high");
  assert.equal(chipLine("Claude", "Opus", null), "Claude · Opus");
  assert.equal(chipLine("Claude", "", "xhigh"), "Claude · extra high");
  assert.equal(chipLine("Grok", "", null), "Grok");
  assert.equal(answerRows(LIST, {})[0].effort, true);
  assert.equal(answerRows(LIST, {})[2].effort, false);
});

test("a bare @claude with two accounts says which one will run (the default); a named one says its own; one account says just the provider", () => {
  const rows = answerRows(LIST, { provider: "codex" });
  assert.equal(runsOn("@claude hello", rows, NAME), "Claude (Personal)");
  assert.equal(runsOn("@claude-work hello", rows, NAME), "Claude (Work)");
  assert.equal(runsOn("@codex hello", rows, NAME), "Codex");
  assert.equal(runsOn("hello @codex", rows, NAME), null);
  assert.equal(runsOn("@design hi", rows, NAME), null);
});
