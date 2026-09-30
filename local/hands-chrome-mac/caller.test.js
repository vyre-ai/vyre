// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import * as mine from "./caller.js";
import * as core from "../../core/modules/index.js";

test("caller: the standalone copy reads labels exactly as core/modules does", () => {
  const labels = ["cli", "local", "deck", "capsule", "mcp", "mcp:agent:kit", "mcp:thread:t1", "cli:agent:kit", "harness:agent:kit", "module:gate", "module:agent:kit", "agent:kit", "cli agent:", "cli agent:???", "", "tailnet:someone", "link:box", undefined];
  for (const l of labels) {
    assert.equal(mine.callerKind(l), core.callerKind(l), String(l));
    assert.equal(mine.agentClaim(l), core.agentClaim(l), String(l));
  }
  assert.equal(mine.AGENT_CLAIM.source, core.AGENT_CLAIM.source);
});
