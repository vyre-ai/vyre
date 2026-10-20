// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { AI_ACCOUNTS_LINE, aiChoices, choiceKind, hasAiStep, pickWords, storedAccounts, withAccounts } from "./runs-on-model.js";

const ACCOUNTS = [
  { id: "k1", provider: "openrouter", kind: "api-key", label: "My OpenRouter" },
  { id: "l1", provider: "codex", kind: "login", label: "My Codex", signed_in_at: 5 },
  { id: "l2", provider: "claude", kind: "login", label: "Not signed in", needs: "sign-in" },
  { id: "t1", provider: "claude", kind: "setup-token", label: "My Claude" },
  { id: "k5", provider: "claude", kind: "api-key", label: "Elsewhere", base_url: "https://example.com" },
  { id: "x1", provider: "acme", kind: "api-key", label: "Not a door provider" },
  { id: "k4", provider: "openrouter", kind: "api-key", label: "Not finished", pending: true },
  { id: "default", provider: "claude", kind: "login", label: "Default", synthetic: true },
];

test("the AI accounts tab shows only for a Flow with an AI step, wherever the step sits", () => {
  assert.equal(hasAiStep({ steps: [{ id: "f", kind: "find" }] }), false);
  assert.equal(hasAiStep({ steps: [{ id: "k", kind: "classify", labels: ["a", "b"] }] }), true);
  assert.equal(hasAiStep({ steps: [{ id: "d", kind: "decide", if: "x", then: [{ id: "e", kind: "extract", fields: [] }], else: [] }] }), true);
  assert.equal(hasAiStep(null), false);
});

test("the choices are the viewer's own finished accounts, sign-ins and keys of every provider", () => {
  assert.deepEqual(aiChoices(ACCOUNTS).map((c) => c.id), ["k1", "l1", "t1"]);
  assert.deepEqual(aiChoices({ accounts: ACCOUNTS }).map((c) => c.id), ["k1", "l1", "t1"]);
  assert.deepEqual(Object.fromEntries(aiChoices(ACCOUNTS).map((c) => [c.id, choiceKind(c)])), { k1: "OpenRouter key", l1: "Codex subscription", t1: "Claude subscription" });
  assert.deepEqual(aiChoices(null), []);
});

test("what is stored is read back, the first form as the main account, and said in plain words", () => {
  const c = aiChoices(ACCOUNTS);
  assert.deepEqual(storedAccounts({ runs_on: { person: "per_a", account: "k1", provider: "openrouter" } }), { main: { account: "k1", provider: "openrouter" }, fallback: null });
  const both = storedAccounts({ runs_on: { person: "per_a", main: { account: "k1", model: "x/y" }, fallback: { account: "l1" } } });
  assert.deepEqual(both, { main: { account: "k1", model: "x/y" }, fallback: { account: "l1" } });
  assert.equal(pickWords(both.main, c), "My OpenRouter, x/y");
  assert.equal(pickWords({ account: "theirs" }, c), "An account of the person it runs as");
  assert.equal(pickWords(null, c), "Your default AI account");
  assert.equal(AI_ACCOUNTS_LINE, "Runs on these accounts no matter who or what starts it.");
});

test("saving sends the picks only: the server sets the person to whoever saves, and a fallback that is the main one is dropped", () => {
  const f = withAccounts({ name: "x", steps: [], runs_on: { person: "per_someone", account: "old" } }, { account: "k1", provider: "openrouter", model: "x/y" }, { account: "l1", provider: "codex" });
  assert.deepEqual(f.runs_on, { main: { account: "k1", provider: "openrouter", model: "x/y" }, fallback: { account: "l1", provider: "codex" } });
  assert.equal(/** @type {any} */ (f).name, "x");
  assert.deepEqual(withAccounts({}, { account: "k1" }, { account: "k1" }).runs_on, { main: { account: "k1" } });
});
