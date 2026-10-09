// @ts-check
// The CI budget for the tools a session is always offered (R031-00i): about 30 tools and about 6,000 tokens (lib/tokens.js), each listed tool counted as the MCP listing sends it
// (name, description, input schema). Every other tool is reached with tools_find and tools_call. Prints both numbers.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens } from "../lib/tokens.js";
import { CORE, META, listing } from "../harness/mcp/core-tools.js";
import { agentCatalog } from "./tools-universe.js";

const MAX_TOOLS = 30, MAX_TOKENS = 6000;

test("the listed tools stay within the budget", () => {
  const catalog = agentCatalog();
  const listed = listing(catalog);
  const size = tokens(JSON.stringify(listed));
  console.log(`tools listed: ${listed.length} (max ${MAX_TOOLS}); tokens: ${size} (max ${MAX_TOKENS}); of ${catalog.length} an agent may use, whose full list is ${tokens(JSON.stringify(catalog.map((c) => ({ name: c.name, description: c.description, inputSchema: c.input }))))} tokens`);
  assert.ok(listed.length <= MAX_TOOLS, `${listed.length} tools are listed; the budget is ${MAX_TOOLS}`);
  assert.ok(size <= MAX_TOKENS, `${size} tokens are listed; the budget is ${MAX_TOKENS}`);
});

test("every core tool exists for an agent, and everything else is reached through tools_call", () => {
  const catalog = agentCatalog();
  const have = new Set(catalog.map((c) => c.name));
  assert.deepEqual(CORE.filter((n) => !have.has(n)), [], "core tools that an agent does not have (renamed or removed?)");
  const names = listing(catalog).map((t) => t.name);
  assert.deepEqual(names, [...CORE, ...META]);
  assert.ok(catalog.length > names.length * 10, "the rest of the tools are many times the core");
});
