import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, copyWords, defaultLabel, keyKindOf, keyShapeOk, labelProblem } from "./ai-accounts-model.js";

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

test("the copy sheet names where from and where to, and counts the confirmations up front: one read per key plus one for the set", () => {
  const w = copyWords({ from: "Juniper Studio", to: "Ivy Labs", count: 3 });
  assert.match(w.lead, /Juniper Studio to Ivy Labs/);
  assert.equal(w.confirm, "You'll confirm 4 times: once to read each of the 3 keys from Juniper Studio, and once to add them to Ivy Labs.");
  assert.match(copyWords({ from: "A", to: "B", count: 1 }).confirm, /confirm 2 times: once to read the key from A, and once to add it to B/);
  assert.equal(copyWords({ from: "A", to: "B", count: 0 }).confirm, "Nothing to confirm.");
  assert.equal(copyWords({ from: "A", to: "B", count: 1 }).button(1), "Copy 1 account");
});

// Fake keys are built from parts so no literal in this file looks like a real key to the secret scan.
test("an Anthropic prefix is never an OpenAI-style key, whatever follows it", () => {
  const a = "sk-" + "ant-", tail = "x".repeat(30);
  const claude = { kind: "anthropic-compatible", provider: "claude", label: "Claude key" };
  assert.deepEqual(keyKindOf(a + "api03-" + tail + "."), claude, "a trailing odd character");
  assert.deepEqual(keyKindOf(a.toUpperCase() + "API03-" + tail), claude, "upper case");
  assert.deepEqual(keyKindOf(a + "oat01-" + tail), claude, "a setup token");
  assert.equal(keyKindOf("sk-" + "proj-" + tail).provider, "codex");
  assert.equal(keyKindOf("sk-" + "or-v1-" + tail).kind, "openrouter");
  const x = keyKindOf("xai-" + tail);
  assert.deepEqual([x.provider, x.base_url], ["grok", "https://api.x.ai/v1"]);
  for (const rest of ["", "a", "-", "_", ".", " x", "é", "0", "oat01-", "api03-" + tail + "\n", tail + "!"]) {
    const k = keyKindOf(a + rest);
    assert.ok(k && k.kind === "anthropic-compatible", JSON.stringify(rest));
  }
});
