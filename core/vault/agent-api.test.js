// @ts-check
// A model's vault.request goes through kernel grants (core/vault/access.js effectFor), not a credential's static scope: an agent or the assistant reaches a credential only through a grant of its own
// (a project's linked vault, a vault shared with it, a task lease), the kernel decides, vault.list shows exactly that set, and each older scope is converted to grants once and logged. Adversarial: wrong
// agent, expired, another credential, revoked parent, an outward act held, the assistant no longer exempt. A real grants store behind core/vault/kernel-rig.js and the real relay over a fake network.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { register } from "./request.js";
import { kernelRig, SPACE } from "./kernel-rig.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const GRAPH = { auth: { type: "bearer" }, hosts: ["graph.example.test"] };

async function mk(t, over = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-agentapi-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig({ agents: { kit: "agt_kit", juno: "agt_juno", assistant: "agt_asst" }, projects: { northwind: "prj_nw", harlow: "prj_hl" }, ...over });
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]) };
  const gate = { items: new Map() };
  const call = async (tool, input) => {
    if (tool === "gate.offer") return { data: { name: input.name } };
    if (tool === "gate.request") { const id = `h${gate.items.size + 1}`; gate.items.set(id, { id, input }); return { data: { id, state: "held", message: `Held as ${id}` } }; }
    return { error: { code: "no_such_tool", message: tool } };
  };
  const tools = new Map();
  register({ vault: v, tool: (name, _c, _d, _i, run) => tools.set(name, { run }), internal: (n, _d, _i, run) => tools.set(n, { run }), call, said: { match: async () => null },
    deps: { lookup: async () => [{ address: "93.184.216.10", family: 4 }], transport: async r => { net.calls.push({ host: r.url.hostname, method: r.method }); return json(200, { ok: true }); } } });
  const secrets = {};
  const cred = async (name, config = GRAPH) => { secrets[name] = fake(name); await v.put({ name, kind: "api-credential", fields: { config: JSON.stringify(config), secret: secrets[name] } }, "cli"); };
  const ask = (input, caller, meta = {}) => tools.get("vault.request").run(input, { caller, ...meta });
  const GET = { method: "GET", url: "https://graph.example.test/v1/a" }, POST = { method: "POST", url: "https://graph.example.test/v1/send", body: { a: 1 } };
  /** A grant of use of a credential to an agent (by id) or a group, from the owner. */
  const give = async (name, subject, over = {}) => {
    const res = await v.access.urn(name);
    if (subject.kind === "actor") await rig.gw.grants.addActor(rig.owner(), subject.actor, { presence: { n: 1 } }).catch(() => {});
    const i = { subject, actions: ["vault.read", "vault.call"], resource: { prefix: res }, conditions: {}, source: "vault:share", ...over };
    return rig.gw.grants.create(rig.owner(), i, { presence: { n: Math.random() } });
  };
  const agent = (n) => ({ kind: "actor", actor: { kind: "agent", id: rig.uid(n), space: SPACE } });
  return { v, db, rig, events, net, gate, secrets, cred, ask, give, agent, GET, POST };
}

test("the wrong agent is refused and the right one runs; no grant means no call, for an agent and for the assistant", async t => {
  const { cred, ask, give, agent, net, GET, v } = await mk(t);
  await cred("graph-api");
  await v.access.convertScopes(); // nothing is scoped: the assistant alone is carried over
  await give("graph-api", agent("kit"));
  assert.equal((await ask({ credential: "graph-api", ...GET }, "mcp:agent:kit")).kind, "read");
  await assert.rejects(ask({ credential: "graph-api", ...GET }, "mcp:agent:juno"), /needs a grant/);
  assert.equal(net.calls.length, 1, "only the granted agent's call went out");
  // the assistant is no longer exempt: a new credential it holds no grant for is refused it
  await cred("other-api");
  await assert.rejects(ask({ credential: "other-api", ...GET }, "mcp", { agentKind: "assistant" }), /needs a grant/);
  await assert.rejects(ask({ credential: "other-api", ...GET }, "mcp"), /the assistant/, "a model with no agent named is the assistant");
  await give("other-api", agent("assistant"));
  assert.equal((await ask({ credential: "other-api", ...GET }, "mcp", { agentKind: "assistant" })).kind, "read");
});

test("another credential is not covered by a grant on this one, and an expired grant opens nothing", async t => {
  const { cred, ask, give, agent, GET, v, rig } = await mk(t);
  await cred("graph-api"); await cred("other-api");
  await v.access.convertScopes();
  await give("graph-api", agent("kit"), { conditions: { when: { expires: rig.clock() + 5000 } } });
  assert.equal((await ask({ credential: "graph-api", ...GET }, "mcp:agent:kit")).kind, "read");
  await assert.rejects(ask({ credential: "other-api", ...GET }, "mcp:agent:kit"), /needs a grant/, "another credential");
  const real = v.clock; v.clock = () => real() + 60_000; // the vault's clock and the kernel's are the one clock here: move it past the grant's end
  for (let i = 0; i < 6000; i++) rig.clock();
  await assert.rejects(ask({ credential: "graph-api", ...GET }, "mcp:agent:kit"), /needs a grant/, "expired");
});

test("an outward act is held for a person even with a grant, and refused outright without one", async t => {
  const { cred, ask, give, agent, GET, POST, v, net, gate } = await mk(t);
  await cred("graph-api");
  await v.access.convertScopes();
  await assert.rejects(ask({ credential: "graph-api", ...POST }, "mcp:agent:kit"), /needs a grant/);
  assert.equal(gate.items.size, 0, "refused, not held");
  await give("graph-api", agent("kit"));
  const held = await ask({ credential: "graph-api", ...POST }, "mcp:agent:kit");
  assert.ok(held.held, "a write under a grant waits for a person");
  assert.equal(net.calls.length, 0);
  assert.equal(gate.items.size, 1);
  assert.equal((await ask({ credential: "graph-api", ...GET }, "mcp:agent:kit")).kind, "read");
});

test("a grant that hangs from a parent dies with it: take the owner's manage away and the converted scope stops", async t => {
  const { cred, ask, agent, GET, v, rig } = await mk(t);
  await cred("graph-api", { ...GRAPH, scope: { projects: "*", agents: ["kit"] } });
  await v.access.convertScopes();
  assert.equal((await ask({ credential: "graph-api", ...GET }, "mcp:agent:kit")).kind, "read");
  const manage = (await rig.gw.grants.list(rig.owner(), {})).find(g => g.source === "vault:create");
  await rig.gw.grants.revoke(rig.owner(), manage.id, "no longer", { presence: { n: 1 } });
  await assert.rejects(ask({ credential: "graph-api", ...GET }, "mcp:agent:kit"), /needs a grant/);
  assert.ok(agent);
});

test("a project's linked vault: a grant to the project reaches the agents on it and not the others", async t => {
  const { cred, ask, give, GET, v, rig } = await mk(t);
  await cred("graph-api");
  await v.access.convertScopes();
  // kit is on the project northwind by its reach grant; juno is not
  const reach = { subject: { kind: "actor", actor: { kind: "agent", id: "agt_kit", space: SPACE } }, actions: ["project.reach"], resource: { prefix: `vyre://${SPACE}/project/prj_nw` }, conditions: {}, source: "projects:reach" };
  await rig.gw.grants.addActor(rig.owner(), reach.subject.actor, { presence: { n: 1 } }).catch(() => {});
  await rig.gw.grants.create(rig.owner(), reach, { presence: { n: 2 } });
  await rig.gw.grants.addActor(rig.owner(), { kind: "agent", id: "agt_juno", space: SPACE }, { presence: { n: 3 } }).catch(() => {});
  await give("graph-api", { kind: "group", id: "project:prj_nw" });
  assert.equal((await ask({ credential: "graph-api", ...GET }, "mcp:agent:kit")).kind, "read");
  await assert.rejects(ask({ credential: "graph-api", ...GET }, "mcp:agent:juno"), /needs a grant/);
});

test("the older scopes become grants once, each conversion is logged, and the assistant keeps what it could reach", async t => {
  const { cred, ask, GET, v, db, events, rig } = await mk(t);
  await cred("by-agent", { ...GRAPH, scope: { projects: "*", agents: ["kit"] } });
  await cred("by-project", { ...GRAPH, scope: { projects: ["northwind"], agents: "*" } });
  await cred("everyone", { ...GRAPH, scope: { projects: "*", agents: "*" } });
  await cred("person-only", GRAPH);
  await v.access.convertScopes();
  const grants = (await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:scope");
  const on = n => grants.filter(g => g.resource.prefix.endsWith(`/item/${n}`)).map(g => g.subject.kind === "group" ? g.subject.id : g.subject.actor.id).sort();
  assert.deepEqual(on("by-agent"), ["agt_asst", "agt_kit"]);
  assert.deepEqual(on("by-project"), ["agt_asst", "project:prj_nw"]);
  assert.deepEqual(on("everyone"), ["agt_asst", "agt_juno", "agt_kit"]);
  assert.deepEqual(on("person-only"), ["agt_asst"], "the assistant, which could reach it, still can");
  assert.equal((await ask({ credential: "by-agent", ...GET }, "mcp:agent:kit")).kind, "read");
  await assert.rejects(ask({ credential: "by-agent", ...GET }, "mcp:agent:juno"), /needs a grant/);
  await assert.rejects(ask({ credential: "person-only", ...GET }, "mcp:agent:kit"), /needs a grant/);
  // logged: one audit row and one event per credential, naming who was given it
  const rows = db.prepare("SELECT name, why FROM vault_audit WHERE action = 'scope-converted' ORDER BY name").all();
  assert.deepEqual(rows.map(r => r.name), ["by-agent", "by-project", "everyone", "person-only"]);
  assert.match(rows[0].why, /agents .*assistant.*kit|agents kit,assistant/);
  assert.equal(events.filter(e => e.type === "vault.scope-converted").length, 4);
  // once: a second run makes nothing and logs nothing
  const before = (await rig.gw.grants.list(rig.owner(), {})).length;
  await v.access.convertScopes();
  assert.equal((await rig.gw.grants.list(rig.owner(), {})).length, before);
  assert.equal(events.filter(e => e.type === "vault.scope-converted").length, 4);
});

test("a model lists exactly the credentials it may use, by the same check, and never a value", async t => {
  const { cred, give, agent, v } = await mk(t);
  await cred("graph-api"); await cred("other-api");
  await v.put({ name: "a-login", kind: "login", fields: { username: "u", password: fake("pw") }, hosts: ["https://app.example.test"] }, "cli");
  await v.access.convertScopes();
  await give("graph-api", agent("kit"));
  assert.deepEqual((await v.access.listFor("kit")).map(i => i.name), ["graph-api"]);
  assert.deepEqual((await v.access.listFor("juno")), []);
  assert.deepEqual((await v.access.listFor("assistant")).map(i => i.name).sort(), ["graph-api", "other-api"], "the assistant, as carried over");
  // a login lent to the agent (agent.grant) is listed too, by name and kind: it holds a grant for it
  await v.access.lend({ agent: "kit", item: "a-login", origin: "https://app.example.test", expires: Date.now() + 3600_000 }, { caller: "cli" }, false);
  assert.deepEqual((await v.access.listFor("kit")).map(i => [i.name, i.kind]).sort(), [["a-login", "login"], ["graph-api", "api-credential"]]);
  assert.deepEqual(await v.access.listFor("juno"), [], "nobody else sees it");
  assert.equal(v.access.modelName({ agent: "Kit" }, "mcp"), "kit");
  assert.equal(v.access.modelName({}, "mcp:agent:juno"), "juno");
  assert.equal(v.access.modelName({}, "mcp"), "assistant");
});

test("a task lease: the doer may use the Connection its approved Kit names, for that task only; anything outside it is refused and nothing outward runs unasked", async t => {
  const kits = { "task-1": { approved: true, kit: "intake", version: "2", credentials: ["cn1"] }, "task-2": { approved: false, kit: "intake", version: "3", credentials: ["cn1"] } };
  const { cred, ask, GET, POST, v, rig, gate, net } = await mk(t, { call: (tool, i) => (tool === "flows.kit.credentials" ? (kits[i.task] ? { data: kits[i.task] } : { error: { code: "not_found", message: "no task" } }) : tool === "connectors.connection.get" ? (["cn1", "cn2"].includes(i.id) ? { data: { id: i.id } } : { error: { code: "not_found", message: "no" } }) : undefined) });
  await cred("conn-cn1"); await cred("conn-cn2");
  await v.access.convertScopes();
  const until = rig.clock() + 5000;
  await assert.rejects(v.access.leaseTask({ task: "task-1", agent: "kit", connections: ["cn2"], until }), /not named by the task's Kit/);
  await assert.rejects(v.access.leaseTask({ task: "task-2", agent: "kit", connections: ["cn1"], until }), /no approved Kit/);
  await assert.rejects(v.access.leaseTask({ task: "task-9", agent: "kit", connections: ["cn1"], until }), /no approved Kit/);
  await assert.rejects(v.access.leaseTask({ task: "task-1", agent: "stranger", connections: ["cn1"], until }), /no agent named/);
  assert.deepEqual(await v.access.leaseTask({ task: "task-1", agent: "kit", connections: ["cn1"], until }), { lent: 1, already: 0 });
  assert.deepEqual(await v.access.leaseTask({ task: "task-1", agent: "kit", connections: ["cn1"], until }), { lent: 0, already: 1 }, "twice is once, so a restart does not double it");
  const lease = (await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source === "vault:lease:task-1");
  assert.equal(lease.length, 1);
  assert.match(lease[0].reason, /intake@2/, "the grant records the Kit and its version");
  assert.deepEqual(lease[0].actions, ["vault.read", "vault.call"], "use only");
  assert.equal((await ask({ credential: "conn-cn1", ...GET }, "mcp:agent:kit")).kind, "read");
  await assert.rejects(ask({ credential: "conn-cn1", ...GET }, "mcp:agent:juno"), /needs a grant/, "another agent than the doer");
  await assert.rejects(ask({ credential: "conn-cn2", ...GET }, "mcp:agent:kit"), /needs a grant/, "another Connection");
  const held = await ask({ credential: "conn-cn1", ...POST }, "mcp:agent:kit");
  assert.ok(held.held && net.calls.length === 1 && gate.items.size === 1, "an outward call is held for a yes, not run");
  // a task's end takes it back; another task's lease of the same Connection to the same agent is independent
  kits["task-3"] = { approved: true, kit: "intake", version: "2", credentials: ["cn1"] };
  await v.access.leaseTask({ task: "task-3", agent: "kit", connections: ["cn1"], until });
  assert.deepEqual(await v.access.leaseEnd({ task: "task-1" }), { ended: 1 });
  assert.equal((await ask({ credential: "conn-cn1", ...GET }, "mcp:agent:kit")).kind, "read", "task-3 still holds it");
  await v.access.leaseEnd({ task: "task-3" });
  await assert.rejects(ask({ credential: "conn-cn1", ...GET }, "mcp:agent:kit"), /needs a grant/);
  // expiry ends it by itself, and the owner's manage is its parent
  await v.access.leaseTask({ task: "task-1", agent: "kit", connections: ["cn1"], until: rig.clock() + 3000 });
  for (let i = 0; i < 4000; i++) rig.clock();
  const real = v.clock; v.clock = () => real() + 10_000;
  await assert.rejects(ask({ credential: "conn-cn1", ...GET }, "mcp:agent:kit"), /needs a grant/, "after its time");
});

test("an agent that rides a person's surface label is held to its grants like any model: no grant, no call; the right agent runs", async t => {
  const { cred, ask, give, agent, net, GET, v } = await mk(t);
  await cred("graph-api");
  await v.access.convertScopes();
  await give("graph-api", agent("kit"));
  for (const who of ["cli:agent:kit", "local:agent:kit", "tailnet:agent:kit"]) {
    assert.equal((await ask({ credential: "graph-api", ...GET }, who)).kind, "read", `${who}: its own grant works`);
    await assert.rejects(ask({ credential: "graph-api", ...GET }, who.replace("kit", "juno")), /needs a grant/, `${who}: another agent has none`);
  }
  assert.equal(net.calls.length, 3, "only the granted agent's calls went out");
  // the person's own surface needs no grant
  assert.equal((await ask({ credential: "graph-api", ...GET }, "cli")).kind, "read");
});
