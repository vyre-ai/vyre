// @ts-check
// Contract test for team/contracts/ext-agents.md (v1): the names, limits and tool set every part shares (lib/outside.js), against the fixtures trust builds with. The module's daemon cases (register,
// grant, read, held write, revoke, leaked token) join this file when core/outside lands (version 1.1).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { callerOf, actorIdOf, idOfCaller, idOfActor, isOutside, MCP_TOOLS, toolsFor, reachLine, LIMITS } from "../../lib/outside.js";
import { extFixtures as F } from "./ext-agents.fixtures.js";

test("an outside agent has one id in three spellings, and nothing else is one", () => {
  assert.equal(callerOf(F.id), F.caller);
  assert.equal(actorIdOf(F.id), F.actor);
  assert.equal(idOfCaller(F.caller), F.id);
  assert.equal(idOfActor(F.actor), F.id);
  assert.equal(isOutside({ caller: F.caller }), true);
  for (const not of ["cli", "mcp", "harness", "module:outside", "ext:", "ext:SHORT", "ext:../etc/passwd", " ext:" + F.id, "ext:" + F.id + ":agent:x", "mcp:ext:" + F.id, "Ext:" + F.id, "device:" + F.id]) assert.equal(isOutside(not), false, not);
  assert.equal(idOfActor("ext_UPPERCASE00"), null);
  assert.equal(idOfActor("vp_" + F.id), null, "a pass id is not an actor id until it is migrated");
  assert.throws(() => callerOf("x"), /10 to 40/);
});

test("the tools /agents-mcp lists are exactly what the agent holds", () => {
  assert.deepEqual(toolsFor([]).map(t => t.name), F.mcp.listedWithNoGrant);
  assert.deepEqual(toolsFor(["records.read"]).map(t => t.name), F.mcp.listedWithRecordsReadOnly);
  const all = toolsFor(["records.read", "records.write", "memory.read", "files.read"]).map(t => t.name);
  assert.deepEqual(all, MCP_TOOLS.map(t => t.name));
  assert.ok(!all.includes("tools_call"), "an outsider reaches the listed tools and no other tool of the registry");
  for (const t of MCP_TOOLS) {
    assert.ok(t.description.trim().split(/\s+/).length <= 25, `${t.name}: a description is at most 25 words`);
    assert.equal(t.inputSchema.type, "object");
  }
  assert.equal(new Set(MCP_TOOLS.map(t => t.name)).size, MCP_TOOLS.length);
});

test("what an agent may reach is one plain line", () => {
  assert.equal(reachLine([]), "has been given nothing yet");
  assert.equal(reachLine([{ kind: "records", types: ["Clients", "Matters"], write: true }]), "reads Clients and Matters; asks to add or change them");
  assert.equal(reachLine([{ kind: "memory", project: "harlow" }, { kind: "files", project: "harlow" }], p => p === "harlow" ? "the Harlow project" : p), "asks the memory of the Harlow project; reads the files of the Harlow project");
  assert.equal(reachLine([{ kind: "vault", items: ["ghl-api"] }]), "uses ghl-api without seeing it");
  assert.equal(reachLine([{ kind: "vault", items: ["a", "b"], reveal: true }]), "uses 2 credentials without seeing them; may ask to see a value");
  assert.equal(F.listed.reach, reachLine([{ kind: "records", types: ["Clients", "Matters"], write: true }]));
  const pass = "0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10";
  assert.equal(idOfActor(actorIdOf(pass)), pass, "a pass made before registration keeps its uuid and its actor");
  assert.equal(idOfCaller(callerOf(pass)), pass);
  assert.ok(LIMITS.maxDays === 90 && LIMITS.defaultRate === 30);
});
