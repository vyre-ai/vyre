// @ts-check
// An agent's look (a shape and a colour, "s3~c5"): set when it is made, changed by agents.update with the same say as any change to the agent, read back by agents.list. A look that is not a
// shape and a colour is refused. In-process registry with fake modules in a temp home.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const THREADS = `export default { async start(ctx) {
  ctx.tool("threads.launch", { internal: true, run: async i => { (globalThis.__launched ||= []).push(i); return { id: "job1" }; } });
  ctx.tool("threads.get", { effect: "read", run: async () => ({ thread: null }) });
  return {};
} };`;
const PROJECTS = `export default { async start(ctx) {
  ctx.tool("projects.list", { effect: "read", run: async () => ({ projects: [{ slug: "harlow-legal", home: "/tmp/x" }] }) });
  ctx.tool("projects.access.check", { effect: "read", run: async () => ({ granted: true }) });
  ctx.tool("projects.access.grant", { run: async () => ({ ok: true }) });
  ctx.tool("projects.access.revoke", { run: async () => ({ ok: true }) });
  ctx.tool("projects.access.clear", { run: async () => ({ ok: true }) });
  return {};
} };`;

const ASSISTANT = `export default { async start(ctx) {
  ctx.tool("assistant.capabilities", { effect: "read", run: async () => ({ text: "CAPS-BLOCK" }) });
  return {};
} };`;

async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { roles: ["box", "local"], does: { tools: ["threads.launch", "threads.get"] } }, THREADS);
  writeModule(root, "projects", { roles: ["box", "local"], does: { tools: ["projects.list", "projects.access.check", "projects.access.grant", "projects.access.revoke", "projects.access.clear"] } }, PROJECTS);
  writeModule(root, "assistant", { roles: ["box", "local"], does: { tools: ["assistant.capabilities"] } }, ASSISTANT);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "agents");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); delete globalThis.__launched; });
  return (tool, input = {}, caller = "local") => reg.call(tool, input, caller);
}

test("a look given at creation is kept and listed", async (t) => {
  const call = await world(t);
  await call("agents.create", { name: "rex", look: "s3~c5" });
  const rows = await call("agents.list");
  assert.equal(rows.find((r) => r.name === "rex").look, "s3~c5");
});

test("an agent made without a look has none, and agents.update sets and clears it", async (t) => {
  const call = await world(t);
  await call("agents.create", { name: "rex" });
  assert.equal((await call("agents.list")).find((r) => r.name === "rex").look ?? null, null);
  await call("agents.update", { name: "rex", look: "s0~c7" });
  assert.equal((await call("agents.list")).find((r) => r.name === "rex").look, "s0~c7");
  await call("agents.update", { name: "rex", look: "" });
  assert.equal((await call("agents.list")).find((r) => r.name === "rex").look ?? null, null);
});

test("a look that is not a shape and a colour is refused, at creation and at update", async (t) => {
  const call = await world(t);
  await assert.rejects(() => call("agents.create", { name: "bad", look: "red" }), /look/);
  await call("agents.create", { name: "rex" });
  await assert.rejects(() => call("agents.update", { name: "rex", look: "s9~c1" }), /look/);
});

test("a model cannot change an agent's look: it proposes, as for any change", async (t) => {
  const call = await world(t);
  await call("agents.create", { name: "rex" });
  await assert.rejects(() => call("agents.update", { name: "rex", look: "s1~c1" }, "mcp"), /propose|person/);
});
