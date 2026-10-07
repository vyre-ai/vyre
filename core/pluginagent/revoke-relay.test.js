// @ts-check
// pluginagent.revoke deletes the agent it made as the revoking person, and (1) a paired device is that person too, so a revoke from the phone removes the agent and does not stop halfway;
// (2) it deletes by the agent's id, never by the name alone, so an agent the person made later under the same name is never hit. In-process registry, no daemon, no kernel.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const PROJECTS = `export default { async start(ctx) {
  ctx.tool("projects.list", { effect: "read", run: async () => ({ projects: [] }) });
  ctx.tool("projects.access.check", { effect: "read", run: async () => ({ granted: true }) });
  ctx.tool("projects.access.grant", { run: async () => ({ ok: true }) });
  ctx.tool("projects.access.revoke", { run: async () => ({ ok: true }) });
  ctx.tool("projects.access.clear", { run: async () => ({ ok: true }) });
  return {};
} };`;
// Stand-in for the presence module's strength answer: a session id says whether its key was attested.
const PRESENCE = `export default { async start(ctx) {
  ctx.tool("presence.person.strength", { internal: true, run: async i => ({ strength: ({ "s-hw": "enclave", "s-enc": "enclave, unattested", "s-pk": "passkey", "s-sw": "software" })[i.id] || null }) });
  return {};
} };`;
const THREADS = `export default { async start(ctx) { ctx.tool("threads.list", { effect: "read", run: async () => [] }); return {}; } };`;

async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "projects", { roles: ["box", "local"], does: { tools: ["projects.list", "projects.access.check", "projects.access.grant", "projects.access.revoke", "projects.access.clear"] } }, PROJECTS);
  writeModule(root, "threads", { roles: ["box", "local"], does: { tools: ["threads.list"] } }, THREADS);
  writeModule(root, "presence", { roles: ["box", "local"], does: { tools: ["presence.person.strength"] } }, PRESENCE);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {} });
  const here = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const core = discover([here]).filter(f => ["agents", "pluginagent"].includes(f.manifest?.name));
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  return (/** @type {string} */ tool, input = {}, caller = "local", /** @type {any} */ meta = {}) => reg.call(tool, input, caller, meta);
}
const names = async (/** @type {any} */ call) => ((await call("agents.list")).data || []).map((/** @type {any} */ a) => a.name);

test("a paired phone revokes only when its session's key was attested; a software device is refused up front with the key still on", async t => {
  const call = await world(t);
  const phone = "device:abcdefghijklmnop";
  const ask = (await call("pluginagent.ask", {}, "mcp")).data;
  assert.ok(!(await call("pluginagent.grant", { id: ask.id }, "local")).error);
  const agent = (await call("pluginagent.status", {}, "mcp")).data.agent;
  // (agents.delete's own callers list is the person's surfaces; "deck" admits an owner's device, which with no session is refused person_session_required.)
  assert.equal((await call("agents.delete", { agent }, phone)).error.code, "person_session_required");
  // Software strength or an unknown session: refused by revoke itself, no session at all: refused by the registry; either way before anything changes.
  for (const person of [{ id: "s-sw" }, undefined, { id: "nope" }]) {
    const r = await call("pluginagent.revoke", {}, phone, person ? { person } : {});
    assert.equal(r.error && r.error.code, person ? "software_key" : "person_session_required", JSON.stringify(r));
    assert.equal((await call("pluginagent.status", {}, "mcp")).data.granted, true, "the key is still on");
    assert.ok((await names(call)).includes(agent), "and the agent still stands");
  }
  // A sideloaded iPhone's or an Android phone's unattested enclave key (hardware on release) revokes, like an attested one: the key is off and the agent is gone.
  const r = await call("pluginagent.revoke", {}, phone, { person: { id: "s-enc" } });
  assert.ok(!r.error && r.data.revoked === true, JSON.stringify(r));
  assert.ok(!(await names(call)).includes(agent), "the agent is gone, not just its key");
  assert.equal((await call("agents.delete", { agent: "x" }, "mcp")).error.code, "denied", "a model still deletes nothing");
});

test("every non-software strength passes (enclave, enclave unattested, passkey)", async t => {
  for (const sid of ["s-hw", "s-enc", "s-pk"]) {
    const call = await world(t);
    const ask = (await call("pluginagent.ask", {}, "mcp")).data;
    assert.ok(!(await call("pluginagent.grant", { id: ask.id }, "local")).error);
    const r = await call("pluginagent.revoke", {}, "device:abcdefghijklmnop", { person: { id: sid } });
    assert.ok(!r.error && r.data.revoked === true, `${sid}: ${JSON.stringify(r)}`);
  }
});

test("revoke deletes by the agent's id: a same-named agent made later is not touched", async t => {
  const call = await world(t);
  const ask = (await call("pluginagent.ask", {}, "mcp")).data;
  assert.ok(!(await call("pluginagent.grant", { id: ask.id }, "local")).error);
  const agent = (await call("pluginagent.status", {}, "mcp")).data.agent;
  const before = (await call("agents.list")).data.find((/** @type {any} */ a) => a.name === agent);
  assert.ok(before && before.id, "agents.list shows the id");
  // The person deletes the plugin's agent by hand and makes their own under the same name.
  assert.ok(!(await call("agents.delete", { agent }, "local")).error);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(!(await call("agents.create", { name: agent, projects: [] }, "local")).error);
  const mine = (await call("agents.list")).data.find((/** @type {any} */ a) => a.name === agent);
  assert.notEqual(mine.id, before.id);
  const r = await call("pluginagent.revoke", {}, "local");
  assert.ok(!r.error, JSON.stringify(r));
  assert.ok((await names(call)).includes(agent), "the person's own agent survives the revoke");
  assert.equal((await call("agents.delete", { agent, id: "0" }, "local")).error.code, "not_found", "a wrong id deletes nothing");
});
