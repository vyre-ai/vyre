// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { choiceKind, runsOnChoices, runsOnLine, withRunsOn } from "./runs-on-model.js";

const ACCOUNTS = [
  { id: "k1", provider: "openrouter", kind: "api-key", label: "My OpenRouter" },
  { id: "k2", provider: "openai-compatible", kind: "api-key", label: "My OpenAI" },
  { id: "l1", provider: "codex", kind: "login", label: "My Codex" },
  { id: "k3", provider: "claude", kind: "api-key", label: "My Anthropic key" },
  { id: "t1", provider: "claude", kind: "setup-token", label: "My Claude" },
  { id: "g1", provider: "grok", kind: "login", label: "My Grok" },
  { id: "g2", provider: "grok", kind: "login", label: "Grok not signed in", needs: "sign-in" },
  { id: "k5", provider: "claude", kind: "api-key", label: "Elsewhere", base_url: "https://example.com" },
  { id: "k4", provider: "openrouter", kind: "api-key", label: "Not finished", pending: true },
  { id: "default", provider: "claude", kind: "login", label: "Default", synthetic: true },
];

test("Runs on offers the viewer's own finished keys and subscription sign-ins", () => {
  assert.deepEqual(runsOnChoices(ACCOUNTS).map((c) => c.id), ["k1", "k2", "l1", "k3", "t1", "g1"]);
  assert.deepEqual(runsOnChoices(/** @type {any} */ (null)), []);
});

test("each choice says what kind of account it is", () => {
  const by = Object.fromEntries(runsOnChoices(ACCOUNTS).map((c) => [c.id, choiceKind(c)]));
  assert.deepEqual(by, { k1: "OpenRouter key", k2: "OpenAI-compatible key", l1: "Codex subscription", k3: "Claude key", t1: "Claude subscription", g1: "Grok subscription" });
});

test("the line says what it runs on now, in plain words", () => {
  const c = runsOnChoices(ACCOUNTS);
  assert.equal(runsOnLine(undefined, c), "Its AI steps run on the default AI account of the person who made it.");
  assert.equal(runsOnLine({ person: "per_a" }, c), "Its AI steps run on the default AI account of the person it runs as.");
  assert.equal(runsOnLine({ person: "per_a", account: "k2" }, c), "Its AI steps run on your account My OpenAI.");
  assert.equal(runsOnLine({ person: "per_a", account: "t1" }, c), "Its AI steps run on your account My Claude.");
  assert.equal(runsOnLine({ person: "per_b", account: "zz" }, c), "Its AI steps run on an account of the person it runs as.");
});

test("picking an account sends the account and provider only: the server sets the person to whoever saves", () => {
  const f = withRunsOn({ name: "x", steps: [], runs_on: { person: "per_someone", account: "old" } }, { id: "t1", provider: "claude" });
  assert.deepEqual(f.runs_on, { account: "t1", provider: "claude" });
  assert.equal(/** @type {any} */ (f).name, "x");
});
