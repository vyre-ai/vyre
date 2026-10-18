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
  const c = cardOf({ name: "scout", look: "s2~c4", instructions: "Find photographers.\nAsk before you book.\nNever pay.\nFourth line.", projects: "*", skills: ["research", "mail"], auth: { vault: "claude-setup-token", fallback: "anthropic-api-key", budget_usd: 20 }, model: "sonnet", effort: "high", computer: true, personal: true });
  assert.equal(c.name, "scout");
  assert.deepEqual(c.grants, ["Can see every project", "Can use a computer of its own in Space's Cloud", "Can read your personal memory", "Runs on your claude-setup-token key", "Falls back to your anthropic-api-key key, up to $20 a month"]);
  assert.deepEqual(c.rows[0], ["Instructions", "Find photographers.\nAsk before you book.\nNever pay.\n(64 characters in all)"]);
  assert.deepEqual(c.rows.slice(1), [["Projects", "Every project"], ["Skills", "research, mail"], ["AI account", "claude-setup-token, then anthropic-api-key (up to $20 a month)"], ["Model", "sonnet"], ["Effort", "high"]]);
});

test("nothing risky set, nothing risky said; a short instruction shows whole with its length", () => {
  const c = cardOf({ name: "a", projects: [], instructions: "Be brief." });
  assert.deepEqual(c.grants, []);
  assert.deepEqual(c.rows, [["Instructions", "Be brief. (9 characters)"], ["Projects", "None yet"]]);
  assert.equal(changeWords("name", " rex "), "Change the new agent: name: rex");
});
