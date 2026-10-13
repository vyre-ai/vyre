// @ts-check
// core/daemon/agent-wake: which kernel tasks wake an agent, and what the wake sends. Fakes for the kernel's task API and the agents module: no daemon, no session.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentWake, wakes } from "./agent-wake.js";

const NOW = 1_000_000_000;
const task = (/** @type {any} */ o = {}) => ({ id: "t1", title: "Refund R-9", state: "ready", source: "flow_step", doer: { kind: "agent", id: "juno" }, assigned_by: { kind: "person", id: "ana" }, output: { kind: "decision" }, form: { instructions: "Escalate to Dana" }, flow: "refund", created_at: NOW - 1000, ...o });

function rig(/** @type {any[]} */ tasks) {
  const woke = /** @type {any[]} */ ([]), edits = /** @type {any[]} */ ([]), logs = /** @type {string[]} */ ([]);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const claimed = new Map();
  const gw = { ask: { get: async (_c, id) => byId.get(id) ?? null, edit: async (_c, id, patch) => { edits.push({ id, patch }); byId.set(id, { ...byId.get(id), ...patch }); } } };
  const callModule = async (tool, input) => {
    assert.equal(tool, "agents.wake");
    woke.push(input);
    if (claimed.has(input.task)) return { thread: claimed.get(input.task), already: true };
    claimed.set(input.task, `th-${input.task}`);
    return { thread: `th-${input.task}`, already: false };
  };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), callModule, log: m => logs.push(m), clock: () => NOW });
  return { onEvent, woke, edits, logs, byId };
}
const created = (/** @type {string} */ id, type = "task.created") => ({ type, data: { task: { id } } });

test("a Flow agent step wakes the agent once, with the title, its instructions and the approver, and the task gets the thread id", async () => {
  const r = rig([task({ record: "vyre://s/refund/9" })]);
  await r.onEvent(created("t1"));
  assert.equal(r.woke.length, 1);
  assert.deepEqual({ ...r.woke[0] }, { task: "t1", agent: "juno", title: "Refund R-9", instructions: "Escalate to Dana", record: "vyre://s/refund/9", approver: "ana", flow: "refund" });
  assert.deepEqual(r.edits, [{ id: "t1", patch: { form: { instructions: "Escalate to Dana", thread: "th-t1" } } }]);
});

test("a restart or a repeated event does not start it again, and writes the thread only once", async () => {
  const r = rig([task()]);
  await r.onEvent(created("t1"));
  await r.onEvent(created("t1"));
  await r.onEvent(created("t1", "task.readied"));
  assert.equal(r.edits.length, 1, "the thread was already on the task");
  assert.equal(new Set(r.woke.map(w => w.task)).size, 1);
});

test("a repeat after a crash between the wake and the write puts the thread on the task", async () => {
  const r = rig([task()]);
  await r.onEvent(created("t1"));
  r.byId.set("t1", task());   // the write was lost
  await r.onEvent(created("t1"));
  assert.equal(r.edits.length, 2);
});

test("a task given to a person wakes nothing, and neither does a to-do, a follower's note, a task not ready, a stale one or a kernel one", async () => {
  const r = rig([
    task({ id: "p", doer: { kind: "person", id: "ana" } }),
    task({ id: "m", source: "manual" }),
    task({ id: "n", form: { brief: "fyi", fyi: true } }),
    task({ id: "w", state: "waiting" }),
    task({ id: "d", state: "done" }),
    task({ id: "old", created_at: NOW - 48 * 3600 * 1000 }),
    task({ id: "k", kernel: true }),
  ]);
  for (const id of ["p", "m", "n", "w", "d", "old", "k", "missing"]) await r.onEvent(created(id));
  await r.onEvent({ type: "task.completed", data: { task: { id: "t1" } } });
  await r.onEvent({ type: "flow.run", data: {} });
  assert.deepEqual(r.woke, []);
});

test("a task made by an agent's request wakes the agent, with no approver when no person made it; a task freed by its dependencies wakes it then", async () => {
  const r = rig([task({ id: "a", source: "assistant_request", assigned_by: { kind: "agent", id: "assistant" }, form: undefined, note: "Do the thing" })]);
  await r.onEvent(created("a", "task.readied"));
  assert.equal(r.woke.length, 1);
  assert.equal(r.woke[0].approver, undefined);
  assert.equal(r.woke[0].instructions, "Do the thing");
  assert.equal(wakes(task(), NOW), true);
});

test("a wake that fails is logged and stops nothing", async () => {
  const gw = { ask: { get: async () => task(), edit: async () => {} } };
  const logs = /** @type {string[]} */ ([]);
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), callModule: async () => { throw new Error("no such agent"); }, log: m => logs.push(m), clock: () => NOW });
  await onEvent(created("t1"));
  assert.match(logs[0], /did not wake its agent \(no such agent\)/);
});

test("a wake that fails marks the task stuck as the agent, with the error in plain words and a next step, and no secret", async () => {
  const stuck = /** @type {any[]} */ ([]), marked = /** @type {any[]} */ ([]);
  const gw = { ask: { get: async () => task(), edit: async () => {}, stuck: async (c, id, info) => { stuck.push({ c, id, info }); } } };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: t => ({ for: t.doer.id }), clock: () => NOW, log: () => {},
    callModule: async (tool, input) => { if (tool === "agents.wake-failed") { marked.push(input); return {}; } throw new Error("OAuth session expired sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"); } });
  await onEvent(created("t1"));
  assert.equal(stuck.length, 1);
  assert.deepEqual(stuck[0].c, { for: "juno" });
  assert.match(stuck[0].info.reason, /juno's AI sign-in has expired/);
  assert.doesNotMatch(stuck[0].info.reason, /ABCDEFGHIJ/);
  assert.equal(stuck[0].info.suggested_fix, "Reconnect the AI account for juno in Settings, then retry.");
  assert.deepEqual(marked, [{ task: "t1", agent: "juno" }]);
});

test("a job thread that ends with its task still open marks it stuck; one that handed it in, or a thread of no task, does nothing", async () => {
  const states = { open: "working", done: "needs_check" };
  let state = states.open, woken = { task: "t1", agent: "juno" };
  const stuck = /** @type {any[]} */ ([]);
  const gw = { ask: { get: async () => task({ state }), edit: async () => {}, stuck: async (_c, id, info) => { stuck.push({ id, info }); } } };
  const mk = () => createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: () => ({}), clock: () => NOW, log: () => {}, callModule: async tool => (tool === "agents.woken" ? woken : {}) });
  const w = mk();
  await w.threadEnded("th1", "exited without starting: out of memory");
  assert.equal(stuck.length, 1);
  assert.match(stuck[0].info.reason, /juno stopped before it finished this task/);
  state = states.done;
  await w.threadEnded("th1");
  woken = /** @type {any} */ (null);
  state = states.open;
  await w.threadEnded("th2");
  assert.equal(stuck.length, 1);
});

test("a named agent is lent its task before it is woken, the lend repeats safely, and the task's end takes it back", async () => {
  const calls = /** @type {string[]} */ ([]);
  const gw = { ask: { get: async () => task(), edit: async () => {} } };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), clock: () => NOW, log: () => {},
    lend: async t => { calls.push(`lend ${t.id} ${t.doer.id}`); }, reclaim: async id => { calls.push(`reclaim ${id}`); },
    callModule: async () => { calls.push("wake"); return { thread: "th", already: false }; } });
  await onEvent(created("t1"));
  assert.deepEqual(calls, ["lend t1 juno", "wake"], "the use is lent first, then the agent is woken");
  await onEvent(created("t1", "task.completed"));
  await onEvent(created("t1", "task.voided"));
  assert.deepEqual(calls.slice(2), ["reclaim t1", "reclaim t1"]);
});

test("a job that stopped with a bare reason but whose thread says the sign-in expired is reported as an expired sign-in", async () => {
  const stuck = /** @type {any[]} */ ([]);
  const gw = { ask: { get: async () => task({ state: "working" }), edit: async () => {}, stuck: async (_c, _id, info) => { stuck.push(info); } } };
  const w = createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: () => ({}), clock: () => NOW, log: () => {},
    callModule: async tool => (tool === "agents.woken" ? { task: "t1", agent: "juno" } : tool === "threads.get" ? { thread: { last_line: "Failed to authenticate: OAuth session expired" } } : {}) });
  await w.threadEnded("th1", "exited");
  assert.match(stuck[0].reason, /^juno's AI sign-in has expired\./);
  assert.equal(stuck[0].suggested_fix, "Reconnect the AI account for juno in Settings, then retry.");
});
