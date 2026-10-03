// @ts-check
// Memory's access layer decided from the kernel chain's facts, not label strings (CUTOVER section H). Every caller class gets the SAME answer from the chain (kernel on) as it
// got from its label (kernel off): the table's rows, run both ways. Only the model and the projects.reach stand-in (a 0.2 module this one asks) are stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { createRig } from "../../test/kernel-rig.js";
import { whoOfChain } from "./who.js";
import memory from "./index.js";

const AGENTS = [{ name: "kit", kind: "assistant", projects: "*" }, { name: "assistant", kind: "assistant", projects: "*" }];
const BLOCKED = new Set(["denied", "person_session_required"]);
const socket = (surface, uid = 501) => ({ kind: "socket", surface, uid, pid: 1, inside_model_process: false, capsule_verified: surface === "capsule" });
const device = (session, path = "wink") => ({ kind: "device", device_key_id: "dk1", person: "per_alex", path, ...(session ? { session } : {}) });
const CAPS = { graph: ["memory.graph", {}], corrections: ["memory.corrections", {}], me: ["memory.me", {}], correct: ["memory.merge", { node: "x", into: "y" }], pin: ["memory.pin", { node: "x" }], write: ["memory.write", { kind: "note", text: "kept", project: "you" }], site: ["memory.site.list", {}] };

async function boot(t, { kernel = null } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const ctx = { name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }),
    tool: (n, d) => tools.set(n, d), memoryRunner: null, ...(kernel ? { kernel } : {}) };
  const h = await memory.start(ctx);
  t.after(() => h.stop());
  /** What a caller can do: for each capability, "yes", or the refusal code. */
  const can = async (caller, meta = {}, bind = () => {}) => {
    const out = {};
    for (const [cap, [tool, input]] of Object.entries(CAPS)) {
      bind();
      try { await tools.get(tool).run(input, { caller, ...meta }); out[cap] = "yes"; }
      catch (e) { const code = /** @type {any} */ (e).code || "failed"; out[cap] = BLOCKED.has(code) ? code : "yes"; }
    }
    return out;
  };
  return { can };
}

const YES = { graph: "yes", corrections: "yes", me: "yes", correct: "yes", pin: "yes", write: "yes", site: "yes" };
// RULING 6 Oct (second deliberate change): an owner device reads as the owner only when signed in, over Wink or the relay alike. Unsigned: nothing personal, and no correct or write.
const NO_READS = { graph: "denied", corrections: "denied", me: "denied" };
const UNSIGNED = { ...YES, ...NO_READS, correct: "person_session_required", write: "person_session_required" };

test("each caller class does exactly what its label did: the table's rows, by the chain and by the label", async t => {
  const rig = await createRig({ agents: ["kit", "assistant"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const on = await boot(t, { kernel: handle }), off = await boot(t);
  const bind = token => () => rig.k.bindCalls(() => (token ? { token } : null));
  const own = (await rig.k.surfaces.open(rig.person("per_alex"), {})).token;
  const agent = (await rig.k.surfaces.open(rig.person("per_alex"), { agent: "kit" })).token;
  const assistant = (await rig.k.surfaces.open(rig.person("per_alex"), { agent: "assistant" })).token;
  const rows = [
    ["the person at this machine (deck)", await on.can("deck", { kernelFacts: socket("deck") }), await off.can("deck"), YES],
    ["the person at this machine (cli)", await on.can("cli", { kernelFacts: socket("cli") }), await off.can("cli"), YES],
    ["the Capsule (named exception)", await on.can("capsule"), await off.can("capsule"), YES],
    ["the person on another device over Wink (was tailnet:), signed in", await on.can("tailnet:alex@example.com", { kernelFacts: device("s1") }), await off.can("tailnet:alex@example.com", { person: { id: "s1" } }), YES],
    ["the same device, not signed in (CHANGED by the ruling: no personal reads)", await on.can("tailnet:alex@example.com", { kernelFacts: device() }), null, UNSIGNED],
    ["the person's device over the relay, signed in (CHANGED by the ruling: it reads as the owner)", await on.can("device:abcdefghijklmnop", { kernelFacts: device("s1", "relay") }), null, YES],
    ["the same relay device, not signed in", await on.can("device:abcdefghijklmnop", { kernelFacts: device(undefined, "relay") }), null, UNSIGNED],
    ["the person's own session or thread", await on.can("mcp:thread:t1", { token: own }, bind(own)), await off.can("mcp:thread:t1"), null],
    ["a named agent (kit)", await on.can("mcp:agent:kit", { token: agent, agent: "kit", granted: "*" }, bind(agent)), await off.can("mcp:agent:kit", { agent: "kit", granted: "*" }), null],
    // The person's own Claude: the kernel's token chain is [person, agent:assistant] (no fact tells a thread from the assistant), and the label forms it replaces were mcp:thread:<id> and mcp:agent:assistant
    ["the person's own Claude (assistant token) against the thread label", await on.can("mcp:thread:t1", { token: assistant }, bind(assistant)), await off.can("mcp:thread:t1"), null],
    ["the person's own Claude (assistant token) against the assistant label", await on.can("mcp:agent:assistant", { token: assistant, agent: "assistant", granted: "*" }, bind(assistant)), await off.can("mcp:agent:assistant", { agent: "assistant", granted: "*" }), null],
  ];
  for (const [name, after, before, expected] of rows) {
    if (before) assert.deepEqual(after, before, `${name}: the chain and the label disagree`);
    if (expected) assert.deepEqual(after, expected, name);
  }
  // spot-check the rows with no declared expectation: an own session may not steer the main graph, read corrections, correct or use the site store
  const session = rows[7][1];
  assert.deepEqual([session.corrections, session.correct, session.site], ["denied", "denied", "denied"]);
  const agentRow = rows[8][1];
  assert.deepEqual([agentRow.corrections, agentRow.correct, agentRow.site], ["denied", "denied", "denied"], "an agent proposes, never decides");
});

test("a tailnet login that is not the owner reads nothing: there is no such chain, and a model on the socket has none either", async t => {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const on = await boot(t, { kernel: handle });
  for (const caller of ["tailnet:bob@example.com", "tailnet-guest:bob", "mcp", "harness"]) {
    const r = await on.can(caller);
    assert.ok(Object.values(r).every(v => v === "denied"), `${caller}: ${JSON.stringify(r)}`);
  }
  // another person of the Space, even with a person chain of their own
  const bob = (await rig.k.surfaces.open(rig.person("per_bob"), {})).token;
  const r = await on.can("deck", { token: bob }, () => rig.k.bindCalls(() => ({ token: bob })));
  assert.ok(Object.values(r).every(v => v === "denied"), JSON.stringify(r));
});

test("who.js reads the chain's facts and nothing else", async () => {
  const rig = await createRig({ agents: ["kit"] });
  const h = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const w = async meta => whoOfChain(await h.chain(meta));
  assert.deepEqual(await w({ kernelFacts: socket("deck") }), { ownerSurface: true, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, module: null });
  assert.deepEqual(await w({ kernelFacts: socket("mobile") }), { ownerSurface: false, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, module: null }, "mobile is not an owner surface, as before");
  assert.deepEqual([(await w({ kernelFacts: device("s1") })).signedIn, (await w({ kernelFacts: device("s1") })).nodeDevice, (await w({ kernelFacts: device("s1", "relay") })).nodeDevice], [true, true, false], "a Wink device reads like tailnet: did, a relay device like device: did");
  assert.equal((await w({ kernelFacts: device() })).signedIn, false);
  const own = (await rig.k.surfaces.open(rig.person("per_alex"), {})).token, ag = (await rig.k.surfaces.open(rig.person("per_alex"), { agent: "kit" })).token;
  assert.equal((await w({ token: own })).ownSession, true);
  assert.deepEqual([(await w({ token: ag })).agent, (await w({ token: ag })).ownSession], ["kit", false]);
});

test("MA-2: a chain with an agent hop is never the person at a surface, whatever facts ride beside it", async t => {
  const rig = await createRig({ agents: ["kit", "assistant"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const on = await boot(t, { kernel: handle });
  const agent = (await rig.k.surfaces.open(rig.person("per_alex"), { agent: "kit" })).token;
  const chain = await handle.chain({ token: agent });
  const w = whoOfChain(chain, await handle.chain({ kernelFacts: socket("deck") }));
  assert.deepEqual([w.ownerSurface, w.device, w.signedIn, w.agent], [false, false, false, "kit"], "agent first: the deck facts beside it make it no surface");
  // end to end: an agent token with deck facts beside it gets none of the person-only rows
  const r = await on.can("mcp:agent:kit", { token: agent, agent: "kit", granted: "*", kernelFacts: socket("deck") }, () => rig.k.bindCalls(() => ({ token: agent })));
  assert.deepEqual([r.corrections, r.correct, r.site], ["denied", "denied", "denied"], JSON.stringify(r));
});

test("MA-3: the person's own session is the kernel's token, never a label: mcp:thread:<id> with no proof is the bare mcp row", async t => {
  const rig = await createRig({ agents: ["kit"] });
  const on = await boot(t, { kernel: rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } }) });
  for (const caller of ["mcp:thread:fake", "mcp:thread:abc123", "mcp", "mcp:agent:assistant"]) {
    const r = await on.can(caller);
    assert.ok(Object.values(r).every(v => v === "denied"), `${caller}: ${JSON.stringify(r)}`);
  }
});

test("MA-4: a session whose token names a chat of more than one person gets nothing personal, whatever surface it came from", async t => {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit", "assistant"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const on = await boot(t, { kernel: handle });
  const chat = await rig.k.gateway.grants.chats.create(rig.person("per_alex"), { people: ["per_bob"] });
  for (const o of [{}, { agent: "assistant" }, { agent: "kit" }]) {
    const tok = (await rig.k.surfaces.open(rig.person("per_alex"), { ...o, chat: chat.id })).token;
    const r = await on.can("deck", { token: tok, kernelFacts: socket("deck"), ...(o.agent ? { agent: o.agent, granted: "*" } : {}) }, () => rig.k.bindCalls(() => ({ token: tok })));
    assert.ok(Object.values(r).every(v => v === "denied"), `${JSON.stringify(o)}: ${JSON.stringify(r)}`);
  }
});

test("RULING 6 Oct: an owner's own device reads personal memory as the owner when signed in, over Wink or the relay; unsigned, not the owner's, or with an agent hop it reads nothing personal", async t => {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const on = await boot(t, { kernel: handle });
  const PERSONAL = ["graph", "corrections", "me"];
  const reads = async (label, meta) => { const r = await on.can(label, meta); return PERSONAL.map(k => r[k]); };
  // 1. signed in, either path: reads
  assert.deepEqual(await reads("device:abcdefghijklmnop", { kernelFacts: device("s1", "relay") }), ["yes", "yes", "yes"], "relay, signed in");
  assert.deepEqual(await reads("device:abcdefghijklmnop", { kernelFacts: device("s1", "wink") }), ["yes", "yes", "yes"], "Wink, signed in");
  // 2. unsigned, either path: nothing personal
  assert.deepEqual(await reads("device:abcdefghijklmnop", { kernelFacts: device(undefined, "relay") }), ["denied", "denied", "denied"], "relay, unsigned");
  assert.deepEqual(await reads("tailnet:alex@example.com", { kernelFacts: device(undefined, "wink") }), ["denied", "denied", "denied"], "Wink, unsigned");
  // 3. a device that is not the owner's: the kernel builds a chain for that member and the gate refuses it
  const bobs = { kind: "device", device_key_id: "dk2", person: "per_bob", path: "relay", session: "s2" };
  assert.deepEqual(await reads("device:abcdefghijklmnop", { kernelFacts: bobs }), ["denied", "denied", "denied"], "another person's device, signed in");
  // 4. any agent hop: nothing personal, whatever device facts ride beside it
  const kit = (await rig.k.surfaces.open(rig.person("per_alex"), { agent: "kit" })).token;
  const r = await on.can("mcp:agent:kit", { token: kit, agent: "kit", granted: "*", kernelFacts: device("s1", "relay") }, () => rig.k.bindCalls(() => ({ token: kit })));
  assert.deepEqual([r.corrections, r.correct], ["denied", "denied"], "an agent hop beside signed-in device facts");
  // and the person-only writes still need the sign-in, as before
  const un = await on.can("device:abcdefghijklmnop", { kernelFacts: device(undefined, "relay") });
  assert.deepEqual([un.correct, un.write], ["person_session_required", "person_session_required"]);
});
