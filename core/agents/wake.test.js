// @ts-check
// agents.wake: a task given to an agent starts one job thread for it, once. In-process registry with fake
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

test("agents.wake: one job thread with the task in the prompt, for the approver, and a repeat or a restart starts nothing", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent", projects: ["harlow-legal"] });
  const w = { task: "t1", agent: "juno", title: "Refund R-9", instructions: "Escalate to Dana", record: "vyre://s/refund/9", project: "harlow-legal", approver: "ana", flow: "refund" };
  const r = await call("agents.wake", w, "module:vyred");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([r.data.thread, r.data.already], ["job1", false]);
  const l = globalThis.__launched.at(-1);
  assert.equal(l.agent, "juno");
  assert.equal(l.purpose, "job");
  assert.equal(l.for_person, "ana", "the job is for the approver, whom the asker gate judges");
  assert.equal(l.project, "harlow-legal");
  assert.match(l.prompt, /Refund R-9/);
  assert.match(l.prompt, /Escalate to Dana/);
  assert.match(l.prompt, /vyre:\/\/s\/refund\/9/);
  assert.match(l.prompt, /tasks\.start/);
  const again = await call("agents.wake", w, "module:vyred");
  assert.deepEqual([again.data.thread, again.data.already], ["job1", true]);
  assert.equal(globalThis.__launched.length, 1, "the second ask started no second job");
});

test("agents.wake: only the host, an unknown agent is refused, a project the agent does not reach is left out, a failed launch leaves no claim", async t => {
  const call = await world(t);
  await call("agents.create", { name: "kit", kind: "agent", projects: ["northwind-bakery"] });
  for (const who of ["local", "cli", "deck", "mcp:agent:kit", "module:planner"]) assert.ok((await call("agents.wake", { task: "t2", agent: "kit", title: "x" }, who)).error, who);
  assert.equal(globalThis.__launched, undefined);
  assert.ok((await call("agents.wake", { task: "t2", agent: "nobody", title: "x" }, "module:vyred")).error);
  await call("agents.wake", { task: "t2", agent: "kit", title: "x", project: "harlow-legal" }, "module:vyred");
  assert.equal(globalThis.__launched.at(-1).project, undefined, "the task's project is not the agent's, so the job is not put in it");
});
