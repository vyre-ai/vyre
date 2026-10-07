// @ts-check
// agents.job: a scheduled job runs as the agent, in a side thread. In-process registry with fake
// threads and projects modules in a temp home: no daemon, no real session is started.

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

test("agents.job: a side thread as the agent, its own preamble and kind, the agent's current thread untouched", async t => {
  const call = await world(t);
  const made = await call("agents.create", { name: "juno", kind: "assistant", projects: "*" });
  assert.equal(made.error, undefined, JSON.stringify(made));
  const r = await call("agents.job", { agent: "juno", prompt: "Draft the digest", project: "harlow-legal" }, "module:planner");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.data.thread, "job1");
  const l = globalThis.__launched.at(-1);
  assert.equal(l.agent, "juno");
  assert.equal(l.agent_kind, "assistant");
  assert.equal(l.purpose, "job");
  assert.equal(l.once, true);
  assert.equal(l.project, "harlow-legal");
  assert.match(l.append, /juno/i);
  assert.match(l.append, /CAPS-BLOCK$/, "the assistant's thread starts with what works on this install");
  const a = (await call("agents.list")).data.find(x => x.name === "juno");
  assert.ok(!a.thread, "the job is not the agent's own thread");
});

test("agents.job: only the planner, and never a project the agent does not reach", async t => {
  const call = await world(t);
  await call("agents.create", { name: "kit", kind: "agent", projects: ["northwind-bakery"] });
  for (const who of ["local", "cli", "deck", "mcp:agent:kit", "module:assistant"]) {
    assert.ok((await call("agents.job", { agent: "kit", prompt: "x" }, who)).error, who);
  }
  const out = await call("agents.job", { agent: "kit", prompt: "x", project: "harlow-legal" }, "module:planner");
  assert.equal(out.error?.code, "denied");
  assert.equal(globalThis.__launched, undefined);
  await call("agents.create", { name: "kit2", kind: "agent", projects: ["harlow-legal"] });
  await call("agents.job", { agent: "kit2", prompt: "x" }, "module:planner");
  assert.doesNotMatch(globalThis.__launched.at(-1).append, /CAPS-BLOCK/, "only the assistant gets it");
});
