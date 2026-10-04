// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as mine from "./caller.js";
import * as core from "../../core/modules/index.js";
import { modelKey as libModelKey } from "../../lib/caller.js";
import { PERSON_SURFACES } from "../../core/presence/index.js";

test("caller: the standalone copy reads labels exactly as core/modules does", () => {
  const labels = ["cli", "local", "deck", "capsule", "mcp", "mcp:agent:kit", "mcp:thread:t1", "cli:agent:kit", "harness:agent:kit", "module:gate", "module:agent:kit", "agent:kit", "cli agent:", "cli agent:???", "", "tailnet:someone", "link:box", undefined];
  for (const l of labels) {
    assert.equal(mine.callerKind(l), core.callerKind(l), String(l));
    assert.equal(mine.agentClaim(l), core.agentClaim(l), String(l));
  }
  assert.equal(mine.AGENT_CLAIM.source, core.AGENT_CLAIM.source);
});

test("caller: the standalone modelKey answers as lib/caller.js does for every label, and a model label is never the person", () => {
  const labels = ["cli", "local", "deck", "capsule", "mcp", "mcp:agent:kit", "mcp:thread:t1", "cli:agent:kit", "cli:thread:t1", "harness", "harness:agent:kit", "module:gate", "hook", "anonymous", "tailnet-guest:sam@harlow.example", "unknown"];
  for (const l of labels) assert.equal(mine.modelKey(l), libModelKey(l), l);
  for (const l of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "harness:thread:t1", "harness:agent:kit"]) assert.notEqual(mine.modelKey(l), null, l);
});

test("caller: the standalone surface list is exactly core/presence PERSON_SURFACES (the sanctioned copy)", () => {
  assert.deepEqual([...mine.SURFACES].sort(), [...PERSON_SURFACES].sort());
});
