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
  assert.equal(l.run_as, "ana", "the job's kernel session is the approver's, not the owner's");
  assert.match(l.prompt, /Refund R-9/);
  assert.match(l.prompt, /Escalate to Dana/);
  assert.match(l.prompt, /vyre:\/\/s\/refund\/9/);
  assert.match(l.prompt, /tasks\.move/);
  assert.match(l.prompt, /tasks\.submit/);
  assert.match(l.prompt, /stuck/);
  const again = await call("agents.wake", w, "module:vyred");
  assert.deepEqual([again.data.thread, again.data.already], ["job1", true]);
  assert.equal(globalThis.__launched.length, 1, "the second ask started no second job");
});

test("agents.wake: only the host, an unknown agent is refused, and a project the agent does not reach is left out", async t => {
  const call = await world(t);
  await call("agents.create", { name: "kit", kind: "agent", projects: ["northwind-bakery"] });
  for (const who of ["local", "cli", "deck", "mcp:agent:kit", "module:planner"]) assert.ok((await call("agents.wake", { task: "t2", agent: "kit", title: "x" }, who)).error, who);
  assert.equal(globalThis.__launched, undefined);
  assert.ok((await call("agents.wake", { task: "t2", agent: "nobody", title: "x" }, "module:vyred")).error);
  await call("agents.wake", { task: "t2", agent: "kit", title: "x", project: "harlow-legal" }, "module:vyred");
  assert.notEqual(globalThis.__launched.at(-1).project, "harlow-legal", "the task's project is not the agent's, so the job is not put in it");
});

test("agents.wake: the thread says where it came from, and the wake message opens with the Flow and step", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent", projects: ["harlow-legal"] });
  const origin = { flow: "fl_1", flow_name: "Refund request", flow_version: 3, run: "run_9", step: "go", step_name: "Handle refund", record: "vyre://s/refund/9", junk: { x: 1 } };
  await call("agents.wake", { task: "t9", agent: "juno", title: "Handle refund", approver: "ana", origin }, "module:vyred");
  const l = globalThis.__launched.at(-1);
  assert.deepEqual(l.flow_origin, { flow: "fl_1", flow_name: "Refund request", flow_version: 3, run: "run_9", step: "go", step_name: "Handle refund", record: "vyre://s/refund/9", task: "t9", approver: "ana" });
  assert.match(l.prompt, /^From Flow Refund request, step Handle refund\./);
});

test("agents.wake: a failed launch keeps the claim as failed and allows one retry, then no more; agents.woken names the task of a thread", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent", projects: ["harlow-legal"] });
  const w = { task: "t5", agent: "juno", title: "x" };
  const ok = await call("agents.wake", w, "module:vyred");
  assert.equal(ok.data.thread, "job1");
  assert.deepEqual((await call("agents.woken", { thread: "job1" }, "module:vyred")).data, { task: "t5", agent: "juno", failed: false, tries: 0 });
  assert.ok((await call("agents.woken", { thread: "job1" }, "local")).error);
  assert.equal((await call("agents.woken", { thread: "nope" }, "module:vyred")).data, null);
  assert.deepEqual((await call("agents.wake-failed", { task: "t5", agent: "juno" }, "module:vyred")).data, { retry: true });
  assert.equal((await call("agents.wake-failed", { task: "t5", agent: "juno" }, "module:vyred")).data.retry, true, "a second report of the same failure is not a second failure");
  const again = await call("agents.wake", w, "module:vyred");
  assert.deepEqual([again.data.already, globalThis.__launched.length], [false, 2], "the retry starts the job once more");
  await call("agents.wake-failed", { task: "t5", agent: "juno" }, "module:vyred");
  assert.deepEqual((await call("agents.wake-failed", { task: "t5", agent: "juno" }, "module:vyred")).data, { retry: false });
  const third = await call("agents.wake", w, "module:vyred");
  assert.equal(third.data.already, true);
  assert.equal(globalThis.__launched.length, 2, "after the retry there is no third start");
});

test("agents.wake: one agent runs at most five jobs at once and starts at most forty an hour, with words; an ended task frees a place, and a repeat or a retry never counts twice", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent" });
  const wake = (/** @type {string} */ id) => call("agents.wake", { task: id, agent: "juno", title: id }, "module:vyred");
  for (let i = 1; i <= 5; i++) assert.equal((await wake(`c${i}`)).error, undefined, `job ${i}`);
  const sixth = await wake("c6");
  assert.equal(sixth.error && sixth.error.code, "busy");
  assert.match(sixth.error.message, /juno already has 5 jobs running, the most it takes at once\. This task waits: retry it when one finishes\./);
  assert.equal(globalThis.__launched.length, 5, "nothing started for the sixth");
  assert.equal((await wake("c1")).data.already, true, "a repeat of a wake that is running is not a new job");
  assert.equal((await call("agents.wake-done", { task: "c1" }, "module:vyred")).data.ended, 1);
  assert.equal((await wake("c6")).error, undefined, "a finished task frees a place");
  for (const caller of ["local", "cli", "module:planner", "mcp:agent:juno"]) assert.ok((await call("agents.wake-done", { task: "c2" }, caller)).error, `${caller} cannot mark a wake over`);
});

test("agents.wake: the hourly cap counts what was started in the last hour, finished or not", async t => {
  const call = await world(t);
  await call("agents.create", { name: "kit", kind: "agent" });
  for (let i = 1; i <= 40; i++) { const r = await call("agents.wake", { task: `h${i}`, agent: "kit", title: "x" }, "module:vyred"); assert.equal(r.error, undefined, `job ${i}: ${JSON.stringify(r.error)}`); await call("agents.wake-done", { task: `h${i}` }, "module:vyred"); }
  const over = await call("agents.wake", { task: "h41", agent: "kit", title: "x" }, "module:vyred");
  assert.equal(over.error && over.error.code, "busy");
  assert.match(over.error.message, /kit has started 40 jobs in the last hour/);
});
