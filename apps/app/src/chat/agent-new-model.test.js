// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isNewAgentTitle, draftIdOf, cardOf, changeWords } from "./agent-new-model.js";

test("only the agents module's title is a new-agent card", () => {
  assert.equal(isNewAgentTitle("Make the agent scout?"), true);
  assert.equal(isNewAgentTitle("Make the agent Scout?"), false);
  assert.equal(isNewAgentTitle("Send the status note?"), false);
});

test("the draft id comes from the task's form, whatever it wraps", () => {
  assert.equal(draftIdOf({ task: { form: { kind: "proposal", what: "agent.new", draft: "new_1", hash: "h" } } }), "new_1");
  assert.equal(draftIdOf({ form: { what: "agent.new", draft: "new_2" } }), "new_2");
  assert.equal(draftIdOf({ task: { form: { what: "agent", draft: "chg_1" } } }), "", "a change to an existing agent is not this card");
  assert.equal(draftIdOf(null), "");
});

test("the card says what the yes grants in plain words: every project, a computer, personal memory, the owner's keys, and the instructions' first lines with their length", () => {
  const c = cardOf({ name: "scout", look: "s2~c4", instructions: "Find photographers.\nAsk before you book.\nNever pay.\nFourth line.", projects: "*", skills: ["research", "mail"], auth: { vault: "claude-setup-token", fallback: "anthropic-api-key", budget_usd: 20 }, model: "sonnet", fallback_model: "haiku", effort: "high", computer: true, personal: true });
  assert.equal(c.name, "scout");
  assert.deepEqual(c.grants, ["Can see every project", "Can use a computer of its own in Space's Cloud", "Can read your personal memory", "Runs on your claude-setup-token key", "Falls back to your anthropic-api-key key, up to $20 a month"]);
  assert.deepEqual(c.rows[0], ["Instructions", "Find photographers.\nAsk before you book.\nNever pay.\n(64 characters in all)"]);
  assert.deepEqual(c.rows.slice(1), [["Projects", "Every project"], ["Skills", "research, mail"], ["AI account", "claude-setup-token, then anthropic-api-key (up to $20 a month)"], ["Model", "sonnet, then haiku if it runs out"], ["Effort", "high"]]);
});

test("nothing risky set, nothing risky said; a short instruction shows whole with its length", () => {
  const c = cardOf({ name: "a", projects: [], instructions: "Be brief." });
  assert.deepEqual(c.grants, []);
  assert.deepEqual(c.rows, [["Instructions", "Be brief. (9 characters)"], ["Projects", "None yet"]]);
  assert.equal(changeWords("name", " rex "), "Change the new agent: name: rex");
});

import { skillGroups, toggled, modelRows, accountRows } from "./agent-new-model.js";

// Fixtures copied from the code: skills.list returns { skills: rows, total, drafts, role } with rows { id: "<level>[/<scope>]/<name>", name, level, scope?, description, tokens } (core/skills/index.js, library.js shape());
// sessions.accounts.list returns the account rows as they are stored (core/sessions/accounts.js: id, provider, label, kind, vault_item, scope, ...), the default Claude one synthetic.
const SKILLS = { skills: [
  { id: "space/research", name: "research", level: "space", description: "Find things", tokens: 120 },
  { id: "agent/kit/mail", name: "mail", level: "agent", scope: "kit", description: "Mail the way kit does", tokens: 80 },
  { id: "agent/scout/leads", name: "leads", level: "agent", scope: "scout", description: "For scout", tokens: 60 },
  { id: "vyre/research", name: "research", level: "vyre", description: "Vyre's own", tokens: 40 },
  { id: "personal/per_a/pdf", name: "pdf", level: "personal", scope: "per_a", description: "", tokens: 30 },
  null,
], total: 5, drafts: 0, role: "owner" };
const ACCOUNTS = [
  { id: "acc_1", provider: "claude", label: "Work Claude", kind: "login", vault_item: "claude-setup-token", uid: 9001, scope: { projects: "*", agents: "*" }, is_default: false, added: 1, updated: 2 },
  { id: "default", provider: "claude", label: "Default", kind: "login", vault_item: null, uid: null, scope: { projects: "*", agents: "*" }, is_default: true, added: 0, updated: 0, synthetic: true },
  { id: "acc_2", provider: "openai", label: "", kind: "key", vault_item: "openai-key" },
];

test("skills in groups: the agent's own first, then yours and the Space's; each once; the chosen ones marked; another agent's skills are not offered", () => {
  const g = skillGroups(SKILLS, ["pdf"], "scout");
  assert.deepEqual(g.map((x) => [x.title, x.skills.map((s) => [s.name, s.on])]), [["For this agent", [["leads", false]]], ["Yours", [["pdf", true]]], ["The Space's", [["research", false]]]]);
  assert.deepEqual(skillGroups(SKILLS, [], "new-one").map((x) => x.title), ["Yours", "The Space's"], "an agent that does not exist yet has no skills of its own");
  assert.deepEqual(skillGroups(null, []), []);
  assert.deepEqual(toggled(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggled(["a", "b"], "a"), ["b"]);
});

test("accounts as the chooser lists them: id and a label (the provider when it has none); the vault item is never carried", () => {
  assert.deepEqual(accountRows(ACCOUNTS), [{ id: "acc_1", label: "Work Claude" }, { id: "default", label: "Default" }, { id: "acc_2", label: "openai" }]);
  assert.deepEqual(accountRows({ accounts: [{ id: "x", label: "X" }] }), [{ id: "x", label: "X" }]);
  assert.deepEqual(accountRows(null), []);
  assert.equal(JSON.stringify(accountRows(ACCOUNTS)).includes("setup-token"), false);
});

test("an account's models: id and label, anything else dropped", () => {
  assert.deepEqual(modelRows({ account: "a1", models: [{ id: "sonnet", label: "Sonnet" }, { id: "opus" }, { label: "no id" }] }), [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "opus" }]);
  assert.deepEqual(modelRows(null), []);
});
