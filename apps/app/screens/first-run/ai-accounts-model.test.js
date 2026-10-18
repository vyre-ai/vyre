import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, defaultLabel, keyKindOf, keyShapeOk, labelProblem } from "./ai-accounts-model.js";

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

test("a key's prefix says what it is, and anything else says nothing", () => {
  assert.deepEqual(keyKindOf("sk-ant-api03-abc"), { kind: "anthropic-compatible", provider: "claude", label: "Claude key" });
  assert.equal(keyKindOf("sk-or-v1-abc").kind, "openrouter");
  assert.equal(keyKindOf("sk-proj-abc").provider, "codex");
  assert.equal(keyKindOf("sk-abc").kind, "openai-compatible");
  const x = keyKindOf("  XAI-abc ");
  assert.deepEqual([x.provider, x.kind, x.base_url], ["grok", "openai-compatible", "https://api.x.ai/v1"]);
  assert.equal(keyKindOf("hello"), null);
  assert.equal(keyKindOf(""), null);
});

test("a key's shape: 12 to 400 characters without spaces or control characters", () => {
  assert.equal(keyShapeOk("sk-ant-123456789"), true);
  assert.equal(keyShapeOk("short"), false);
  assert.equal(keyShapeOk("sk-ant-with space1234"), false);
  assert.equal(keyShapeOk("a".repeat(401)), false);
});
