// @ts-check
// The once-only registry defaults (reviewer-2's group D audit, the lead's ruling 4 Oct): (1) a state-changing tool with no `callers` list is the person's surfaces and modules only, (2) a module hop
// carries the original caller class, (3) undeclared input keys are refused. Plus two FROZEN counts that can only go down: the tools that declare no `effect` and the tools whose input schema lists no
// properties. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import path from "node:path";

// FROZEN: lower these when an owner declares `effect` or a properties list on a tool; never raise them. A name that ends in a read verb but writes is a bug for its owner.
const NO_EFFECT_DECLARED = 4; // the four tools this test registers itself; every real tool declares its effect
const NO_PROPERTIES_LIST = 0;

async function world(t) {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zdef", { does: { tools: ["zdef.make", "zdef.list", "zdef.open", "zdef.relay"] }, needs: { tools: [] } }, `export default { async start(ctx) {
    ctx.tool("zdef.make", { input: { type: "object", properties: { name: { type: "string" } } }, run: async (i, meta) => ({ made: i.name, origin: meta.origin || null }) });
    ctx.tool("zdef.list", { input: { type: "object", properties: {} }, run: async () => ({ rows: [] }) });
    ctx.tool("zdef.open", { callers: ["cli", "mcp"], input: { type: "object", properties: { name: { type: "string" } } }, run: async () => ({ ok: true }) });
    ctx.tool("zdef.relay", { callers: ["cli", "mcp"], input: { type: "object", properties: {} }, run: async () => { const a = await ctx.call("zdef.make", { name: "via module" }); return a; } });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  return d;
}

test("a state-changing tool with no callers list is the person's surfaces; an agent is denied, a read verb and a declared list are untouched", { timeout: 60_000 }, async t => {
  const d = await world(t);
  const call = (tool, input, caller) => d.registry.call(tool, input, caller, {});
  const first = await call("zdef.make", { name: "x" }, "cli");
  assert.equal(first.data?.made, "x", JSON.stringify(first) + JSON.stringify(d.registry.status().find(m => m.name === "zdef")));
  for (const agent of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness"]) assert.equal((await call("zdef.make", { name: "x" }, agent)).error?.code, "denied", `${agent} is refused a write with no callers list`);
  assert.ok(!(await call("zdef.list", {}, "mcp")).error, "a read verb at the end of the name is a read");
  assert.ok(!(await call("zdef.open", { name: "x" }, "mcp")).error, "an explicit callers list is the owner's word");
});

test("a module hop carries the original caller class: an agent through a module is still an agent; the person through a module is the person; a module on its own works", { timeout: 60_000 }, async t => {
  const d = await world(t);
  const rel = await d.registry.call("zdef.relay", {}, "mcp", { thread: "t1" });
  assert.ok(rel.error || (rel.data && rel.data.error), "the agent's relay to a person-only write is refused: " + JSON.stringify(rel));
  const person = await d.registry.call("zdef.relay", {}, "cli", {});
  assert.equal(person.data?.data?.made, "via module", "the person's own call through a module works: " + JSON.stringify(person));
  assert.equal(person.data?.data?.origin, "cli", "the tool can read the original caller as meta.origin");
});

test("the tools that hand out credentials, names, grants and devices refuse a module hop made for a model, whatever their callers list says", { timeout: 60_000 }, async t => {
  const d = await world(t);
  for (const tool of ["vault.put", "vault.get", "names.claim", "grants.create", "spaces.devices.remove"]) {
    if (!d.registry.tools.has(tool)) continue;
    const r = await d.registry.call(tool, {}, "module:zdef", { origin: "mcp:thread:t1" });
    assert.equal(r.error?.code, "denied", `${tool} through a module for an agent: ${JSON.stringify(r)}`);
  }
  assert.ok(d.registry.tools.has("vault.put") || d.registry.tools.has("names.claim"), "at least one of them exists here");
});

test("undeclared input keys are refused for a client and accepted from a module; a schema with no properties list is taken as written", { timeout: 60_000 }, async t => {
  const d = await world(t);
  const extra = await d.registry.call("zdef.make", { name: "x", resume: "other-thread" }, "cli", {});
  assert.equal(extra.error?.code, "bad_input"); assert.match(extra.error.message, /resume/);
  assert.ok(!(await d.registry.call("zdef.make", { name: "x", resume: "y" }, "module:zdef", {})).error, "a module's own call is not held to it");
});

test("hygiene: the number of tools that declare no effect and of tools with no properties list is frozen and can only go down", { timeout: 120_000 }, async t => {
  const d = await world(t);
  const tools = [...d.registry.tools.entries()].filter(([, def]) => !def.internal && !def.hook);
  const noEffect = tools.filter(([, def]) => !def.effectDeclared).length;
  const noProps = tools.filter(([, def]) => !(def.input && def.input.properties)).length;
  console.log(`registry hygiene: ${noEffect} tools declare no effect, ${noProps} have no properties list, of ${tools.length}`);
  assert.ok(noEffect <= NO_EFFECT_DECLARED, `tools with no declared effect rose to ${noEffect}: declare effect on the new ones`);
  assert.ok(noProps <= NO_PROPERTIES_LIST, `tools with no properties list rose to ${noProps}: list the properties on the new ones`);
});
