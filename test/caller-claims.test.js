// A caller that carries an agent or thread claim is that agent, whatever transport label it rides on.
// callerKind used to strip ":agent:x" and ":thread:x" and keep the surface ("cli:agent:kit" read as
// "cli"), so a reach "person" tool and every explicit callers list such as ["cli", "local"] admitted it
// (reviewer-2, 2 Oct 2026). This tries every label shape with a claim against a person-reach tool and
// an explicit-callers tool, and checks the helpers that decide on a label alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, validate, Registry, callerKind, callerAllowed, agentClaim, ownerDevice, ownerOverTailnet, canonicalCaller } from "../core/modules/index.js";
import { isPerson } from "../lib/caller.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import { tempHome, writeModule } from "./helpers.js";

const SURFACES = ["cli", "local", "deck", "capsule", "mobile"];
/** Every way a claim can ride on a label. */
const SHAPES = [];
for (const s of SURFACES) for (const claim of ["agent:x", "thread:x", "agent:", "agent:???", "agent:Kit_2-b", "AGENT:x", "Agent:x", "THREAD:x"]) {
  SHAPES.push(`${s}:${claim}`, `${s} ${claim}`, `${s}\t${claim}`, `${s}:${claim}:more`, `${s}:agent:a:thread:b`);
}
const WITH_CLAIM = [...SHAPES, "tailnet:alex@example.com agent:kit", "tailnet:alex@example.com:agent:kit", "tailnet:thread:t1", "tailnet:alex@example.com thread:t1", "tailnet:agent:kit", "device:abcdefghijklmnop agent:kit"];

test("callerKind: a claim on a surface label is a model session, never the surface", () => {
  for (const l of SHAPES.filter(l => /(agent|thread):/i.test(l))) {
    const k = callerKind(l);
    assert.ok(!SURFACES.includes(k), `${JSON.stringify(l)} read as ${k}`);
  }
  assert.equal(callerKind("cli:agent:kit"), "mcp");
  assert.equal(callerKind("capsule:agent:kit"), "mcp");
  assert.equal(callerKind("cli:thread:t1"), "mcp");
  assert.equal(callerKind("mcp:agent:kit"), "mcp");
  assert.equal(callerKind("harness:agent:kit"), "harness");
  assert.equal(callerKind("module:gate"), "module");
  assert.equal(callerKind("tailnet:agent:kit"), "tailnet", "an agent's node keeps the kind no list admits");
  for (const s of SURFACES) assert.equal(callerKind(s), s);
});

test("the label helpers refuse a claim wherever it sits", () => {
  for (const l of WITH_CLAIM) {
    assert.equal(ownerDevice(l), false, `ownerDevice ${JSON.stringify(l)}`);
    assert.equal(ownerOverTailnet(l), false, `ownerOverTailnet ${JSON.stringify(l)}`);
    assert.equal(isPerson(l), false, `isPerson ${JSON.stringify(l)}`);
    assert.equal(callerAllowed(["cli", "local", "deck", "capsule"], l), false, `callerAllowed ${JSON.stringify(l)}`);
    assert.equal(callerAllowed(["deck"], l), false, `callerAllowed deck ${JSON.stringify(l)}`);
    assert.equal(callerAllowed(["tailnet"], l), false, `callerAllowed tailnet ${JSON.stringify(l)}`);
  }
  assert.ok(agentClaim("cli agent:") !== null && agentClaim("CLI:AGENT:x") !== null, "an empty or upper case claim is still a claim");
  // The real shapes still work.
  assert.equal(ownerDevice("tailnet:alex@example.com"), true);
  assert.equal(ownerDevice("tailnet:Alex@Example.com"), true);
  assert.equal(ownerDevice("TAILNET:alex@example.com"), false, "the prefix is case sensitive");
  for (const s of SURFACES.filter(s => s !== "mobile")) assert.equal(isPerson(s), true, s);
});

/** A module with a reach "person" tool, an explicit-callers tool, and one for agents. */
async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "bakery", { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "bakery.person", summary: "p", reach: "person" }, { name: "bakery.list", summary: "l", reach: "anyone" }, { name: "bakery.agents", summary: "a", reach: "anyone" }] } },
    `export default { async start(ctx) {
      ctx.tool("bakery.person", { input: { type: "object" }, run: async () => ({ ran: "person" }) });
      ctx.tool("bakery.list", { input: { type: "object" }, callers: ["cli", "local"], run: async () => ({ ran: "list" }) });
      ctx.tool("bakery.agents", { input: { type: "object" }, callers: ["mcp"], run: async () => ({ ran: "agents" }) });
      return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  const found = discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] }));
  await reg.start(found, { role: "local" });
  t.after(() => db.close());
  return reg;
}

test("a person tool and an explicit callers list refuse every claim shape, and keep admitting the real callers", async t => {
  const reg = await world(t);
  for (const real of ["cli", "local", "deck", "capsule"]) assert.equal((await reg.call("bakery.person", {}, real)).data?.ran, "person", real);
  for (const real of ["cli", "local"]) assert.equal((await reg.call("bakery.list", {}, real)).data?.ran, "list", real);
  assert.equal((await reg.call("bakery.person", {}, "tailnet:alex@example.com")).data?.ran, "person");
  for (const l of WITH_CLAIM) {
    for (const tool of ["bakery.person", "bakery.list"]) {
      const r = await reg.call(tool, {}, l);
      assert.ok(r.error, `${tool} as ${JSON.stringify(l)} ran: ${JSON.stringify(r)}`);
    }
  }
  // An agent's own session is still what an agents tool is for, on every spelling that reads as one.
  for (const l of ["mcp:agent:kit", "mcp:thread:t1", "cli:agent:kit", "capsule:thread:t1"]) assert.equal((await reg.call("bakery.agents", {}, l)).data?.ran, "agents", l);
  assert.ok((await reg.call("bakery.agents", {}, "cli")).error, "a person's surface is not an agent session");
});

test("canonicalCaller makes a claim on any other label an unnamed model session", () => {
  for (const l of SHAPES.filter(l => /agent:/i.test(l))) assert.equal(canonicalCaller(l), "mcp:agent:(unnamed)", JSON.stringify(l));
  for (const l of SHAPES.filter(l => /thread:/i.test(l) && !/agent:/i.test(l))) assert.equal(canonicalCaller(l), "mcp:thread:(unnamed)", JSON.stringify(l));
  assert.equal(canonicalCaller("cli:agent:juno"), "mcp:agent:(unnamed)", "no name survives: the claimed name is never looked up");
  assert.equal(canonicalCaller("CLI:AGENT:Kit"), "mcp:agent:(unnamed)");
  assert.equal(canonicalCaller("tailnet:alex@example.com agent:kit"), "mcp:agent:(unnamed)");
  assert.equal(canonicalCaller("device:abcdefghijklmnop agent:kit"), "mcp:agent:(unnamed)");
  assert.equal(agentClaim("mcp:agent:(unnamed)"), "(unnamed)");
  // Real callers and a model session's own shapes come back untouched.
  for (const l of ["cli", "local", "deck", "capsule", "mobile", "mcp", "harness", "mcp:agent:kit", "mcp:thread:t1", "harness:agent:kit", "tailnet:agent:kit", "tailnet:alex@example.com", "module:gate", "module:agent:kit", "link:box", "anonymous", ""]) assert.equal(canonicalCaller(l), l, JSON.stringify(l));
  assert.equal(canonicalCaller(undefined), undefined);
});

test("a tool sees the neutral caller, so a guard on mcp:agent:<name> refuses cli:agent:kit and cannot look up its name", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "bakery", { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "bakery.who", summary: "w", reach: "anyone" }] } },
    `export default { async start(ctx) {
      ctx.tool("bakery.who", { input: { type: "object" }, run: async (i, meta) => ({ caller: meta.caller }) });
      return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  const found = discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] }));
  await reg.start(found, { role: "local" });
  t.after(() => db.close());
  const seen = async c => (await reg.call("bakery.who", {}, c)).data?.caller;
  assert.equal(await seen("cli:agent:kit"), "mcp:agent:(unnamed)");
  assert.equal(await seen("capsule:thread:t9"), "mcp:thread:(unnamed)");
  assert.equal(await seen("cli"), "cli");
  assert.equal(await seen("mcp:agent:kit"), "mcp:agent:kit");
  // The shape every guard in the tree reads.
  const guard = c => /^mcp:agent:(.+)$/.exec(String(c || ""));
  for (const c of ["cli:agent:kit", "deck agent:kit", "local:agent:", "CAPSULE:AGENT:x"]) assert.ok(guard(await seen(c)), c);
});

test("a rewritten claim loses what vyred verified, keeps its raw label, and a name that disagrees with the verified agent is refused", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "bakery", { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "bakery.meta", summary: "m", reach: "anyone" }] } },
    `export default { async start(ctx) {
      ctx.tool("bakery.meta", { input: { type: "object" }, run: async (i, meta) => ({ caller: meta.caller, raw: meta.callerRaw || null, agent: meta.agent || null, kind: meta.agentKind || null }) });
      return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  const found = discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] }));
  await reg.start(found, { role: "local" });
  t.after(() => db.close());
  // A surface label that claims the assistant, with an agent identity attached: the identity is not trusted.
  const r = (await reg.call("bakery.meta", {}, "cli:agent:juno", { agent: "juno", agentKind: "assistant", granted: "*" })).data;
  assert.deepEqual(r, { caller: "mcp:agent:(unnamed)", raw: "cli:agent:juno", agent: null, kind: null });
  // A real model-session label with its verified agent keeps it; a different verified agent is a refusal.
  assert.deepEqual((await reg.call("bakery.meta", {}, "mcp:agent:juno", { agent: "juno", agentKind: "assistant" })).data, { caller: "mcp:agent:juno", raw: null, agent: "juno", kind: "assistant" });
  assert.equal((await reg.call("bakery.meta", {}, "mcp:agent:juno", { agent: "kit", agentKind: "agent" })).error?.code, "denied");
});
