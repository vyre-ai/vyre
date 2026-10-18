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

test("the card says what will be made: instructions, projects, skills, account and budget, model, effort, and the owner's two", () => {
  const c = cardOf({ name: "scout", look: "s2~c4~e1~m2~t3~b1~h5", instructions: "Find photographers.", projects: [], skills: ["research", "mail"], auth: { vault: "claude-setup-token", fallback: "anthropic-api-key", budget_usd: 20 }, model: "sonnet", effort: "high", computer: true, personal: true });
  assert.equal(c.name, "scout");
  assert.deepEqual(c.rows, [["Instructions", "Find photographers."], ["Projects", "None yet"], ["Skills", "research, mail"], ["AI account", "claude-setup-token, then anthropic-api-key (up to $20 a month)"], ["Model", "sonnet"], ["Effort", "high"], ["Computer", "Its own, in Space's Cloud"], ["Personal memory", "It may read yours"]]);
  assert.deepEqual(cardOf({ name: "a", projects: "*" }).rows, [["Projects", "All projects"]]);
  assert.equal(changeWords("name", " rex "), "Change the new agent: name: rex");
});
