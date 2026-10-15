// @ts-check
// agents.flow-say: a person writes in a Flow's chat and the agent wakes for them, with the Flow and its recent runs as context. In-process registry with fake threads and flows modules in a temp home.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const THREADS = `export default { async start(ctx) {
  ctx.tool("threads.launch", { internal: true, run: async i => { (globalThis.__launched ||= []).push(i); return { id: "job" + globalThis.__launched.length }; } });
  ctx.tool("threads.get", { effect: "read", run: async () => ({ thread: null }) });
  return {};
} };`;
const FLOWS = `export default { async start(ctx) {
  ctx.tool("flows.describe", { effect: "read", run: async i => { if (i.id === "secret") throw Object.assign(new Error("not shared with you"), { code: "denied" }); return { lines: ["When a refund is asked, hand it to juno.", "Step 1: juno drafts the reply."] }; } });
  ctx.tool("flows.runs", { effect: "read", run: async i => ([{ id: "run_9", state: "done", started_at: 1760000000000, finished_at: 1760000060000 }, { id: "run_8", state: "failed", started_at: 1759900000000 }]) });
  return {};
} };`;

async function world(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { roles: ["box", "local"], does: { tools: ["threads.launch", "threads.get"] } }, THREADS);
  writeModule(root, "flows", { roles: ["box", "local"], does: { tools: ["flows.describe", "flows.runs"] } }, FLOWS);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["agents"].includes(f.manifest?.name));
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); delete globalThis.__launched; });
  return (tool, input = {}, caller = "local") => reg.call(tool, input, caller);
}

test("a person writing in a Flow's chat wakes the agent in the Flow's chat, with the Flow and its recent runs in the prompt", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent" });
  const r = await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "Why did run 8 fail?" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const l = globalThis.__launched.at(-1);
  assert.equal(l.agent, "juno");
  assert.equal(l.purpose, "job");
  assert.deepEqual([l.flow_origin.flow, l.flow_origin.run], ["refunds", "run_9"], "it joins the Flow's chat, under the newest run");
  assert.match(l.prompt, /Step 1: juno drafts the reply/);
  assert.match(l.prompt, /run_9: done/);
  assert.match(l.prompt, /run_8: failed/);
  assert.match(l.prompt, /Why did run 8 fail\?/);
});

test("Reply to this run narrows it to that run", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent" });
  const r = await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "Retry it", run: "run_8" });
  assert.equal(r.data.run, "run_8");
  assert.equal(globalThis.__launched.at(-1).flow_origin.run, "run_8");
  assert.match(globalThis.__launched.at(-1).prompt, /about run run_8/);
});

test("only a person writes in a Flow's chat, only in a Flow they can read, and an empty message wakes nothing", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent" });
  const before = (globalThis.__launched || []).length;
  assert.ok((await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "hi" }, "module:wink")).error, "a module is refused");
  assert.equal((await call("agents.flow-say", { agent: "juno", flow: "secret", text: "hi" })).error.code, "denied", "a Flow the person cannot read");
  assert.equal((await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "   " })).error.code, "bad_input");
  assert.equal((globalThis.__launched || []).length, before, "nothing woke");
});

test("a run id must be a run of that Flow: another Flow's run, or one that is not there, wakes nothing", async t => {
  const call = await world(t);
  await call("agents.create", { name: "juno", kind: "agent" });
  const before = (globalThis.__launched || []).length;
  const r = await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "retry it", run: "run_of_another_flow" });
  assert.equal(r.error?.code, "not_found");
  assert.equal((globalThis.__launched || []).length, before, "nothing woke");
  assert.equal((await call("agents.flow-say", { agent: "juno", flow: "refunds", text: "retry it", run: "run_8" })).error, undefined, "a run of that Flow is fine");
});
