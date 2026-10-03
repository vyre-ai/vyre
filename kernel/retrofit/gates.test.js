import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyGates, parseCaller } from "./gates.js";

const def = (over = {}) => ({ module: "demo", ...over });
function fake(tools, { presence, firstParty = () => true, modules = {} } = {}) {
  return { tools: new Map(Object.entries(tools)), modules: new Map(Object.entries(modules)), isFirstParty: firstParty, deps: { presence } };
}
const call = (g, tool, d, caller, meta = {}, input = {}, door = false) => g.before({ tool, def: d, caller, meta, input, door });

test("parseCaller: person surfaces, devices, agent claims, models, modules and strangers", () => {
  assert.deepEqual([parseCaller("deck", false).kind, parseCaller("deck", false).id], ["person", "owner"]);
  assert.equal(parseCaller("cli:agent:kit", false).kind, "agent", "an agent claim is never the person, whatever label carries it");
  assert.equal(parseCaller("mcp", false).id, "assistant");
  assert.equal(parseCaller("harness", false).kind, "agent");
  assert.deepEqual(parseCaller("module:email", false).id, "email");
  assert.equal(parseCaller("hook", false).id, "hooks");
  assert.equal(parseCaller("device:abcdefghijklmnop", true).device, "device:abcdefghijklmnop");
  assert.equal(parseCaller("device:abcdefghijklmnop", true).person_session, true);
  assert.equal(parseCaller("tailnet-guest:g@x", false).id, "guest:g@x");
  assert.equal(parseCaller("anonymous", false).id, "legacy-anonymous");
  assert.equal(parseCaller("cli extra", false).kind, "service", "a label that only starts like a surface is not one");
});

test("gates: callers, visibility, hook, internal and outward refuse with the registry's own codes", async () => {
  const g = createLegacyGates({ registry: fake({ "a.open": def(), "a.cli": def({ callers: ["cli"] }), "a.internal": def({ internal: true }), "a.hook": def({ hook: true }), "a.out": def({ outward: true }) }) });
  const t = (name, d, c, m) => call(g, name, d, c, m).then(r => (r ? r.error.code : "pass"));
  const tools = Object.fromEntries([["a.open", def()], ["a.cli", def({ callers: ["cli"] })], ["a.internal", def({ internal: true })], ["a.hook", def({ hook: true })], ["a.out", def({ outward: true })]]);
  assert.equal(await t("a.open", tools["a.open"], "anonymous"), "pass");
  assert.equal(await t("a.cli", tools["a.cli"], "cli"), "pass");
  assert.equal(await t("a.cli", tools["a.cli"], "mcp"), "denied");
  assert.equal(await t("a.internal", tools["a.internal"], "deck"), "no_such_tool");
  assert.equal(await t("a.internal", tools["a.internal"], "module:x"), "pass");
  assert.equal(await t("a.hook", tools["a.hook"], "hook"), "pass");
  assert.equal(await t("a.hook", tools["a.hook"], "cli"), "no_such_tool");
  assert.equal(await t("a.open", tools["a.open"], "hook"), "no_such_tool");
  assert.equal(await t("a.out", tools["a.out"], "deck"), "pass");
  assert.equal(await t("a.out", tools["a.out"], "mcp"), "held_unavailable");
  assert.equal(await t("a.out", tools["a.out"], "cli:agent:kit"), "held_unavailable");
});

test("gates: a device acts as the person only with the person's session, for a person-only or proof-needing tool", async () => {
  const presence = { required: (tool) => tool === "a.proof" };
  const reg = fake({ "a.proof": def({ presence: true }), "a.plain": def() }, { presence });
  const g = createLegacyGates({ registry: reg });
  const dev = "device:abcdefghijklmnop";
  assert.equal((await call(g, "a.proof", reg.tools.get("a.proof"), dev)).error.code, "person_session_required");
  assert.equal(await call(g, "a.proof", reg.tools.get("a.proof"), dev, { person: true }), null);
  assert.equal(await call(g, "a.plain", reg.tools.get("a.plain"), dev), null);
  assert.equal((await call(g, "a.proof", reg.tools.get("a.proof"), "tailnet-guest:g@x")).error.code, "denied");
});

test("gates: presence and asked requirements come from the kernel; modules never need a proof", async () => {
  const presence = { required: tool => tool === "a.proof" };
  const reg = fake({ "a.proof": def({ callers: null }), "a.ask": def({ reach: "asked" }), "a.plain": def() }, { presence });
  const g = createLegacyGates({ registry: reg });
  const q = (tool, caller) => ({ tool, def: reg.tools.get(tool), caller, meta: {}, input: {} });
  assert.equal(await g.needsPresence(q("a.proof", "deck")), true);
  assert.equal(await g.needsPresence(q("a.proof", "module:x")), false);
  assert.equal(await g.needsPresence(q("a.plain", "deck")), false);
  assert.equal(await g.needsAsk(q("a.ask", "mcp")), true);
  assert.equal(await g.needsAsk(q("a.ask", "mcp:agent:kit")), true);
  assert.equal(await g.needsAsk(q("a.ask", "module:x")), true);
  assert.equal(await g.needsAsk(q("a.ask", "deck")), false);
  assert.equal(await g.needsAsk(q("a.plain", "mcp")), false);
});

test("gates: an added module reaches only declared tools, and a door call skips the check", async () => {
  const modules = { added: { dir: "/x/added", manifest: { name: "added" } } };
  const reg = fake({ "a.declared": def({ declaredReach: true, reach: "anyone" }), "a.core": def({ declaredReach: true, reach: "modules" }), "a.undeclared": def(), "added.own": def({ module: "added" }) }, { firstParty: dir => dir !== "/x/added", modules });
  const g = createLegacyGates({ registry: reg });
  const t = async (tool, door = false) => { const r = await call(g, tool, reg.tools.get(tool), "module:added", {}, {}, door); return r ? r.error.code : "pass"; };
  assert.equal(await t("a.declared"), "pass");
  assert.equal(await t("a.core"), "not_declared");
  assert.equal(await t("a.undeclared"), "not_declared");
  assert.equal(await t("added.own"), "pass");
  assert.equal(await t("a.undeclared", true), "pass");
});

test("K2-2: presence and asked fail closed: only an allow means no requirement", async () => {
  const boom = { required: () => { throw new Error("compile blew up"); } };
  const reg = fake({ "a.plain": def() }, { presence: boom });
  const g = createLegacyGates({ registry: reg });
  const q = { tool: "a.plain", def: reg.tools.get("a.plain"), caller: "deck", meta: {}, input: {} };
  assert.equal(await g.needsPresence(q), true, "a throwing compile needs a proof");
  const reg2 = fake({ "a.plain": def() });
  const g2 = createLegacyGates({ registry: reg2 });
  assert.equal(await g2.needsAsk({ tool: "a.missing", def: undefined, caller: "mcp", meta: {}, input: {} }), true, "an unknown tool needs the person's words");
  assert.equal(await g2.needsAsk({ tool: "a.plain", def: reg2.tools.get("a.plain"), caller: "deck", meta: {}, input: {} }), false);
});

test("K2-3: the production chain builder cannot mint a person from a string; the legacy builder serves only the legacy Space", async () => {
  const { createChainBuilder, createLegacyChainBuilder, LEGACY_SPACE } = await import("../core/chain.js");
  const prod = createChainBuilder({ space: "spc_aaaaaaaaaaaa", owner: "o", owner_uid: 1, key: Buffer.alloc(32, 1) });
  assert.equal("fromLegacy" in prod, false);
  assert.throws(() => createLegacyChainBuilder({ space: "spc_aaaaaaaaaaaa" }), { code: "bad_input" });
  const c = createLegacyChainBuilder({ space: LEGACY_SPACE }).fromLegacy({ kind: "person", id: "owner", legacy: "cli" });
  assert.equal(c.space, LEGACY_SPACE);
});

test("person reach and the assistant: open unless a reason keeps it the person's; ask-first is held; an unclassified tool is refused", async () => {
  const { personRefusesAgent, agentOpensPerson, agentAskFirst } = await import("../../core/modules/index.js");
  const { PERSON_ONLY, OPEN, ASK_FIRST } = await import("../../core/modules/agent-reach.js");
  const person = { reach: "person" };
  const open = [...OPEN][0], only = [...PERSON_ONLY.keys()][0], ask = [...ASK_FIRST.keys()][0];
  for (const c of ["cli:agent:kit", "mcp:agent:kit", "harness:agent:kit", "cli:thread:x"]) {
    assert.equal(personRefusesAgent(open, person, c), false, `${open} for ${c}`);
    assert.equal(agentOpensPerson(open, person, c), true, `${open} reaches ${c} on any of its surfaces`);
    assert.equal(personRefusesAgent(only, person, c), true, `${only} stays the person's for ${c}`);
    assert.equal(personRefusesAgent("brand.new.tool", person, c), true, "an unclassified tool is refused until it is classified");
    assert.equal(agentAskFirst(ask, c), true, `${ask} is held for ${c}`);
  }
  for (const c of ["cli", "local", "deck", "capsule", "mobile", "tailnet:alex"]) { assert.equal(personRefusesAgent(only, person, c), false, c); assert.equal(agentAskFirst(ask, c), false, c); }
  assert.equal(agentOpensPerson(open, person, "module:agent:kit"), false, "a module is not a surface");
  assert.equal(personRefusesAgent(only, { reach: "anyone" }, "cli:agent:kit"), false, "only person reach");
  for (const [n, r] of [...PERSON_ONLY, ...ASK_FIRST]) assert.ok(typeof r === "string" && r.length > 8, `${n} carries its reason`);
  const all = [...OPEN, ...PERSON_ONLY.keys(), ...ASK_FIRST.keys()];
  assert.equal(new Set(all).size, all.length, "a tool is in exactly one list");
});
