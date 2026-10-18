import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, defaultLabel, labelProblem, providerOfKey } from "./ai-accounts-model.js";

test("the providers are the ones the server can sign in to, from the one list", () => {
  assert.deepEqual([...PROVIDERS], ["claude", "codex", "grok"]);
});

test("an account is named after its provider until that name is taken, then numbered", () => {
  assert.equal(defaultLabel("Claude", []), "Claude");
  assert.equal(defaultLabel("Claude", ["Claude"]), "Claude 2");
  assert.equal(defaultLabel("Claude", ["claude", "Claude 2"]), "Claude 3");
  assert.equal(defaultLabel("Codex", ["Claude"]), "Codex");
});

test("a name must be there, one line, at most 80 characters, and not used twice", () => {
  assert.equal(labelProblem("Work", []), "");
  assert.notEqual(labelProblem("  ", []), "");
  assert.notEqual(labelProblem("a".repeat(81), []), "");
  assert.notEqual(labelProblem("a\nb", []), "");
  assert.notEqual(labelProblem("work", ["Work"]), "");
  assert.equal(labelProblem("Personal", ["Work"]), "");
});

test("a key's prefix says whose it is, and anything else says nothing", () => {
  assert.equal(providerOfKey("sk-ant-api03-abc"), "claude");
  assert.equal(providerOfKey("sk-proj-abc"), "codex");
  assert.equal(providerOfKey("sk-abc"), "codex");
  assert.equal(providerOfKey("xai-abc"), "grok");
  assert.equal(providerOfKey("  XAI-abc "), "grok");
  assert.equal(providerOfKey("hello"), null);
  assert.equal(providerOfKey(""), null);
});
