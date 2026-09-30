// @ts-check
// The approval prompt names the module, the item, the project scope and the agent that asked (reviewer-2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { grantPrompt } from "./prompt.js";

test("the approval prompt names the agent and the project", () => {
  const p = grantPrompt({ name: "harlow-drive", module: "planner", project: "harlow", by: "mcp:agent:kit" });
  assert.match(p, /planner/);
  assert.match(p, /"harlow-drive"/);
  assert.match(p, /in project harlow/);
  assert.match(p, /asked by agent kit/);
});

test("the approval prompt says every project when none is named, and no agent for a module or a person", () => {
  assert.equal(grantPrompt({ name: "api-a", module: "planner", by: "module:planner" }), 'Let planner use "api-a" in every project while you are away');
  assert.match(grantPrompt({ name: "api-a", module: "planner", watcher: "inbox", by: "cli" }, true), /planner\/inbox use "api-a" in every project while you are away; this moves it out/);
});

import { putPrompt, kindWord } from "./prompt.js";

test("the save prompt speaks plainly: a person's word for the kind, and your vault", () => {
  assert.equal(putPrompt({ name: "billing-key", kind: "api-key", replacing: false }), 'Add a key "billing-key" to your vault');
  assert.equal(putPrompt({ name: "ms-graph", kind: "api-credential", replacing: false }), 'Add a key "ms-graph" to your vault');
  assert.equal(putPrompt({ name: "site", kind: "login", replacing: true }), 'Replace the login "site" in your vault');
  assert.equal(putPrompt({ name: "visa", kind: "card", replacing: false }), 'Add a card "visa" to your vault');
  assert.equal(putPrompt({ name: "todo", kind: "note", replacing: false }), 'Add a note "todo" to your vault');
  assert.equal(putPrompt({ name: "id", kind: "identity", replacing: false }), 'Add an ID "id" to your vault');
  assert.equal(putPrompt({ name: "x", kind: "nonsense", replacing: false }), 'Add an item "x" to your vault');
  for (const raw of ["api-credential", "api-key", "env-set", "db-url", "ssh-key"]) assert.ok(!putPrompt({ name: "n", kind: raw, replacing: false }).includes(raw), `${raw} never appears`);
  assert.equal(kindWord("pat"), "key");
});
