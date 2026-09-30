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
