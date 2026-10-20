import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { accountsOf, chosen, detailLine, detailRows, effortChoices, effortFor, emptyWords, groupsOf, modelOf, nameOf, parsePick, pickValue, searchModels, tokensWord } from "./model-choice.js";

/** The service's answer for one model (lib/model-registry.js modelView), with sample names. */
const view = (/** @type {any} */ o) => ({ key: `${o.provider}/${o.id}`, vendor: null, version: null, context: null, max_output: null, price: null, vision: null, tools: null, reasoning: null, efforts: [], default_effort: null, ...o });
const DEEP = view({ id: "lab-deep-2", name: "Lab Deep 2", provider: "claude", vendor: "Anthropic", version: "2026-09-21", context: 1000000, max_output: 128000, price: { in: 4, out: 20 }, vision: true, tools: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" });
const PLAIN = view({ id: "acme/plain", name: "Plain Chat", provider: "openrouter", vendor: "Acme", context: 32000, price: { in: 0.2, out: 0.6 }, tools: false });
const ACCOUNTS = [
  { id: "ac_1", provider: "claude", label: "Work", kind: "login", signed_in_at: 1 },
  { id: "ac_2", provider: "openrouter", label: "Router", kind: "api-key" },
  { id: "ac_3", provider: "codex", label: "Waiting", kind: "login", signed_in_at: null },
  { id: "default", provider: "claude", label: "Default", kind: "login", synthetic: true },
  { id: "ac_4", provider: "grok", label: "Pending", kind: "api-key", pending: true },
];

test("groups: the person's usable accounts, each with the models its own list gives, in the one shape", () => {
  const accounts = accountsOf(ACCOUNTS);
  assert.deepEqual(accounts.map((a) => a.id), ["ac_1", "ac_2"], "an account not signed in, waiting on its owner, or the machine's stand-in is not a place to pick a model from");
  const groups = groupsOf(accounts, [{ models: [DEEP, { nope: 1 }] }, null]);
  assert.deepEqual(groups.map((g) => [g.account.label, g.models.map((m) => m.id)]), [["Work", ["lab-deep-2"]], ["Router", []]], "a failed list is an empty group; a row without an id is dropped");
  assert.equal(modelOf({ id: "x", efforts: ["low", "none", "turbo"] }, "grok")?.efforts.join(), "low", "only effort levels a turn can be set to");
});

test("each row says who makes it, its context, its price and whether it sees images and uses tools, only what the provider says", () => {
  assert.equal(detailLine(DEEP), "Anthropic · 1M context · $4 / $20 · vision · tools");
  assert.equal(detailLine(PLAIN), "Acme · 32K context · $0.20 / $0.60");
  assert.equal(detailLine(modelOf({ id: "bare" }, "openai-compatible")), "", "nothing known, nothing said");
  assert.deepEqual(detailRows(DEEP), ["Version 2026-09-21", "Reads 1M tokens, writes up to 128K", "$4 in, $20 out per million tokens", "Works with images, tools and reasoning"]);
  assert.equal(tokensWord(1050000), "1.05M");
  assert.equal(tokensWord(200000), "200K");
});

test("the effort control shows only for a model that takes effort, with that model's own levels", () => {
  assert.deepEqual(effortChoices(DEEP), [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]]);
  assert.deepEqual(effortChoices(PLAIN), [], "no effort levels: no control");
  assert.deepEqual(effortChoices(null), []);
  const few = modelOf({ id: "few", efforts: ["low", "high"] }, "grok");
  assert.deepEqual(effortChoices(few).map(([e]) => e), ["low", "high"], "its own levels, not a fixed set");
  assert.equal(effortFor(DEEP, "max"), "max", "a kept level the model takes stays");
  assert.equal(effortFor(few, "medium"), "low", "a kept level it does not take falls to its middle one");
  assert.equal(effortFor(DEEP, null), "high", "else the model's own default");
  assert.equal(effortFor(PLAIN, "high"), "", "a model with no effort has none");
});

test("search narrows by name, id, vendor or account and keeps each account's group; the chosen row is the account's own when it is named", () => {
  const groups = groupsOf(accountsOf(ACCOUNTS), [{ models: [DEEP] }, { models: [PLAIN, view({ id: "lab-deep-2", name: "Lab Deep 2 (routed)", provider: "openrouter" })] }]);
  assert.deepEqual(searchModels(groups, "acme").map((g) => [g.account.id, g.models.map((m) => m.name)]), [["ac_2", ["Plain Chat"]]]);
  assert.deepEqual(searchModels(groups, "work").map((g) => g.account.id), ["ac_1"], "an account's name finds all its models");
  assert.equal(searchModels(groups, "").length, 2);
  assert.equal(chosen(groups, { account: "ac_2", model: "lab-deep-2" })?.account.id, "ac_2");
  assert.equal(chosen(groups, { provider: "claude", model: "lab-deep-2" })?.account.id, "ac_1", "a saved choice names the provider and model: the first account that gives it");
  assert.equal(chosen(groups, { model: "gone" }), null);
  const v = pickValue(groups[1].account, PLAIN);
  assert.deepEqual(parsePick(v), { account: "ac_2", provider: "openrouter", model: "acme/plain" }, "a model id with a slash survives the value");
  assert.equal(nameOf(groups, "lab-deep-2", "claude"), "Lab Deep 2", "the real name, never a guessed family word");
  assert.equal(nameOf(groups, "unknown-1"), "unknown-1", "a model no account of theirs gives keeps its id");
  assert.match(emptyWords([]), /Connect your own AI account in Settings, AI accounts/);
});
