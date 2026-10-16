// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentHost } from "../core/daemon/peer.js";
import { PROVEN_HARNESS_AGENT_CALLERS, PROVEN_NAMED_AGENT_CALLERS } from "./proven-agent-callers.js";
import { OPEN } from "../core/modules/agent-reach.js";

test("peer ancestry treats Claude, Codex and Grok agent hosts alike", () => {
  for (const host of ["claude", "codex", "grok", "gemini"]) {
    assert.equal(agentHost(`/usr/bin/${host} --resume`), true, host);
    assert.equal(agentHost(`node /usr/local/bin/${host}`), true, `${host} via node wrapper`);
  }
  assert.equal(agentHost("/usr/bin/bash -c echo"), false);
});

test("proven agent caller labels cover MCP and harness surfaces", () => {
  assert.ok(PROVEN_NAMED_AGENT_CALLERS.length >= 3);
  assert.ok(PROVEN_NAMED_AGENT_CALLERS.every((c) => /^mcp:agent:[a-z][a-z0-9_-]{0,39}$/.test(c)));
  for (const tool of ["wink.install.issue", "wink.install.complete", "spaces.pair.install"]) {
    assert.ok(OPEN.has(tool), tool);
    for (const caller of [...PROVEN_NAMED_AGENT_CALLERS, ...PROVEN_HARNESS_AGENT_CALLERS]) assert.ok(caller.startsWith("mcp:") || caller.startsWith("harness:"));
  }
});
