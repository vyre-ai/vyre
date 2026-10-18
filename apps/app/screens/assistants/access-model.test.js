// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCards, areaLine, refusal, stateFrom, summary, switchCall, toolCall } from "./access-model.js";

const SAMPLE = { assistant: "assistant", tools: [{ name: "records.*", at: 5 }], screens: [{ id: "vault", label: "Vault", off: true }, { id: "mail", label: "Mail and messages", off: false }] };

test("the page reads the box's state, says what is off, and builds the one call a switch makes", () => {
  const s = stateFrom(SAMPLE);
  assert.deepEqual(s?.screens.map((x) => [x.id, x.off]), [["vault", true], ["mail", false]]);
  assert.equal(summary(s), "2 things are turned off for your agent.");
  assert.match(summary(stateFrom({ screens: [] })), /can do what you can do/);
  assert.equal(stateFrom({}), null);
  assert.equal(areaLine(true), "Your agent cannot use this.");
  assert.deepEqual(switchCall("vault", false), { tool: "assistant.access.narrow", input: { screens: ["vault"] } });
  assert.deepEqual(switchCall("vault", true), { tool: "assistant.access.restore", input: { screens: ["vault"] } });
});

test("a tool to turn off must look like a tool; a refusal is in plain words", () => {
  assert.deepEqual(toolCall("  Records.LIST "), { tool: "assistant.access.narrow", input: { tools: ["records.list"] } });
  assert.deepEqual(toolCall("records.*"), { tool: "assistant.access.narrow", input: { tools: ["records.*"] } });
  assert.match(/** @type {any} */ (toolCall("everything")).problem, /not a tool name/);
  assert.match(/** @type {any} */ (toolCall("")).problem, /Type a tool name/);
  assert.equal(refusal("denied", "x"), "Only you can change what your agent may do.");
  assert.match(refusal("presence_required", ""), /needs your approval/);
});

test("each agent is a card: the assistant first, then the others by name, with a line that says what it is", () => {
  const cards = agentCards([{ name: "zed", kind: "agent", instructions: "Reviews contracts\nmore" }, { name: "kit", kind: "assistant" }, { name: "amy", kind: "agent" }, { nope: 1 }]);
  assert.deepEqual(cards, [{ name: "kit", sub: "Your assistant" }, { name: "amy", sub: "Agent" }, { name: "zed", sub: "Reviews contracts" }]);
  assert.deepEqual(agentCards({ agents: [{ name: "a", kind: "agent" }] }).map((c) => c.name), ["a"]);
  assert.deepEqual(agentCards(null), []);
});
