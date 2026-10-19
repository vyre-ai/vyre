// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runsOnChoices, runsOnLine, withRunsOn } from "./runs-on-model.js";

const ACCOUNTS = [
  { id: "k1", provider: "openrouter", kind: "api-key", label: "My OpenRouter" },
  { id: "k2", provider: "openai-compatible", kind: "api-key", label: "My OpenAI" },
  { id: "l1", provider: "codex", kind: "login", label: "My Codex" },
  { id: "k3", provider: "claude", kind: "api-key", label: "My Anthropic key" },
  { id: "k4", provider: "openrouter", kind: "api-key", label: "Not finished", pending: true },
  { id: "default", provider: "claude", kind: "login", label: "Default", synthetic: true },
];

test("Runs on offers only the viewer's own finished API key accounts a Flow's AI step can use", () => {
  assert.deepEqual(runsOnChoices(ACCOUNTS).map((c) => c.id), ["k1", "k2"]);
  assert.deepEqual(runsOnChoices(/** @type {any} */ (null)), []);
});

test("the line says what it runs on now, in plain words", () => {
  const c = runsOnChoices(ACCOUNTS);
  assert.equal(runsOnLine(undefined, c), "Its AI steps run on the default key of the person who made it.");
  assert.equal(runsOnLine({ person: "per_a" }, c), "Its AI steps run on the default key of the person it runs as.");
  assert.equal(runsOnLine({ person: "per_a", account: "k2" }, c), "Its AI steps run on your account My OpenAI.");
  assert.equal(runsOnLine({ person: "per_b", account: "zz" }, c), "Its AI steps run on an account of the person it runs as.");
});

test("picking an account sends the account and provider only: the server sets the person to whoever saves", () => {
  const f = withRunsOn({ name: "x", steps: [], runs_on: { person: "per_someone", account: "old" } }, { id: "k1", provider: "openrouter", label: "My OpenRouter" });
  assert.deepEqual(f.runs_on, { account: "k1", provider: "openrouter" });
  assert.equal(/** @type {any} */ (f).name, "x");
});
