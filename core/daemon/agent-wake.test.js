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
    callModule: async (tool, input) => { if (tool === "agents.wake-failed") { marked.push(input); return {}; } throw new Error("OAuth session expired " + "sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"); } });
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
    callModule: async tool => { calls.push(tool === "agents.wake" ? "wake" : tool); return { thread: "th", already: false }; } });
  await onEvent(created("t1"));
  assert.deepEqual(calls, ["lend t1 juno", "wake"], "the use is lent first, then the agent is woken");
  await onEvent(created("t1", "task.completed"));
  await onEvent(created("t1", "task.voided"));
  assert.deepEqual(calls.slice(2), ["agents.wake-done", "reclaim t1", "agents.wake-done", "reclaim t1"], "the wake is marked over, then the lend is taken back");
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

test("a withdrawn task ends the thread its wake started, never one the task's form names", async () => {
  const calls = /** @type {any[]} */ ([]);
  const wakeRecord = new Map([["t1", "th-real"]]);
  // the doer edited the task's form to point at someone else's thread
  const gw = { ask: { get: async () => task({ form: { thread: "th-victim" } }), edit: async () => {} } };
  const callModule = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    calls.push({ tool, input });
    if (tool === "agents.woken") return input.task && wakeRecord.has(input.task) ? { task: input.task, agent: "juno", thread: wakeRecord.get(input.task), failed: false, tries: 0 } : null;
    return {};
  };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), callModule, clock: () => NOW });
  await onEvent({ type: "task.withdrawn", data: { task: { id: "t1" } } });
  const stops = calls.filter((c) => ["threads.stop", "gate.withdraw-thread", "approvals.withdraw-thread"].includes(c.tool));
  assert.equal(stops.length, 3);
  assert.ok(stops.every((c) => c.input.thread === "th-real"), "the thread comes from the wake's own record");
  calls.length = 0;
  await onEvent({ type: "task.withdrawn", data: { task: { id: "t-never-woken" } } });
  assert.equal(calls.filter((c) => c.tool === "threads.stop").length, 0, "a task that was never woken stops nothing");
});

test("a stuck reason hides a key of any shape: letters, digits, dashes, dots, slashes, plus and equals", async () => {
  const { sayWhy } = await import("./agent-wake.js");
  for (const key of ["QWxhZGRpbjpvcGVuIHNlc2FtZQ+/AbCdEfGh==", "sk-ant" + "-api03-AbCdEfGhIjKlMnOpQrStUv", "AbCdEfGhIjKl/MnOpQrStUvWxYz0123", "abc+def+ghi+jkl+mno+pqr+stu"]) {
    const r = sayWhy("juno", `the model said ${key} was refused`);
    assert.ok(!r.reason.includes(key.slice(4, 18)), `${key} is not in the reason: ${r.reason}`);
    assert.match(r.reason, /\[removed\]/);
  }
  assert.match(sayWhy("juno", "plain words about a stop").reason, /plain words about a stop/, "ordinary words stay");
});

test("the agent chain stays inside the Flows host: it is built in one place, handed to the wake and nowhere else", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./flows-host.js", import.meta.url), "utf8");
  const uses = src.split("\n").filter(l => /\bagentChain\b/.test(l));
  assert.ok(uses.length <= 2, `agentChain is built once and handed to createAgentWake once: ${uses.length} lines`);
  assert.ok(uses.some(l => /const agentChain = /.test(l)), "built here");
  assert.ok(uses.some(l => /createAgentWake\(/.test(l)), "handed to the wake");
  assert.ok(!/\bagentChain\b\s*[,:}]/.test(src.slice(src.indexOf("return {", src.indexOf("createAgentWake(")))), "it is not part of anything the host returns");
});

test("a task an agent handed on wakes the agent for the person the kernel recorded, and never for one the task merely names", async () => {
  const r = rig([task({ id: "h1", source: "assistant_request", assigned_by: { kind: "agent", id: "assistant" }, requested_for: "ana", form: undefined, note: "Do it" }), task({ id: "h2", source: "assistant_request", assigned_by: { kind: "agent", id: "assistant" }, form: undefined, note: "Do it" }),
    task({ id: "h3", assigned_by: { kind: "person", id: "ben" }, requested_for: "ana" })]);
  for (const id of ["h1", "h2", "h3"]) await r.onEvent(created(id));
  assert.equal(r.woke.find(w => w.task === "h1").approver, "ana", "the person the request began with");
  assert.equal(r.woke.find(w => w.task === "h2").approver, undefined, "no person, no approver");
  assert.equal(r.woke.find(w => w.task === "h3").approver, "ben", "a person who assigned it stays the approver");
});

test("a job that ends before its agent started the task is woken once more, quietly; the second time the task is stuck", async () => {
  const woke = /** @type {any[]} */ ([]), marked = /** @type {any[]} */ ([]), stuck = /** @type {any[]} */ ([]);
  const t = task({ id: "r1" });
  const gw = { ask: { get: async () => t, edit: async () => {}, stuck: async (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ info) => { stuck.push({ id, info }); } } };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: x => ({ for: x.doer.id }), clock: () => NOW, log: () => {},
    callModule: async (tool, input) => {
      if (tool === "agents.wake") { woke.push(input); return { thread: `job${woke.length}`, already: false }; }
      if (tool === "agents.woken") return { task: "r1", agent: "juno", failed: false, tries: 0 };
      if (tool === "agents.wake-failed") { marked.push(input); return {}; }
      return {};
    } });
  await onEvent(created("r1"));
  assert.equal(woke.length, 1);
  await onEvent.threadEnded("job1", "stopped");
  assert.equal(woke.length, 2, "woken again once, the task still ready");
  assert.deepEqual(marked, [{ task: "r1", agent: "juno" }], "the first wake's claim was freed for the retry");
  assert.deepEqual(stuck, [], "not stuck after the first end");
  await onEvent.threadEnded("job2", "stopped");
  assert.equal(woke.length, 2, "and not a third time");
  assert.equal(stuck.length, 1, "the second end marks it stuck, in words");
  assert.match(stuck[0].info.reason, /juno stopped before it finished/);
});

test("a wake that is refused leaves nothing lent: the lend made for the job is ended before the task is marked stuck", async () => {
  const calls = /** @type {string[]} */ ([]);
  const gw = { ask: { get: async () => task(), edit: async () => {}, stuck: async () => { calls.push("stuck"); } } };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: () => ({}), clock: () => NOW, log: () => {},
    lend: async t => { calls.push(`lend ${t.id}`); }, reclaim: async id => { calls.push(`reclaim ${id}`); },
    callModule: async tool => { if (tool === "agents.wake") throw new Error("this agent has too many jobs running"); return {}; } });
  await onEvent(created("t1"));
  assert.deepEqual(calls, ["lend t1", "reclaim t1", "stuck"]);
});

test("a job thread that ends with its task still open ends what was lent for it, whether the task is woken again or marked stuck", async () => {
  const calls = /** @type {string[]} */ ([]);
  const t = task({ id: "r1" });
  const gw = { ask: { get: async () => t, edit: async () => {}, stuck: async () => { calls.push("stuck"); } } };
  const onEvent = createAgentWake({ space: "s", gw, chain: () => ({}), agentChain: () => ({}), clock: () => NOW, log: () => {},
    lend: async x => { calls.push(`lend ${x.id}`); }, reclaim: async id => { calls.push(`reclaim ${id}`); },
    callModule: async tool => (tool === "agents.woken" ? { task: "r1", agent: "juno" } : tool === "agents.wake" ? { thread: "job", already: false } : {}) });
  await onEvent(created("r1"));
  await onEvent.threadEnded("job", "stopped");
  assert.deepEqual(calls, ["lend r1", "reclaim r1", "lend r1"], "ended with the first job, lent again for the retry");
  calls.length = 0;
  await onEvent.threadEnded("job", "stopped");
  assert.deepEqual(calls, ["reclaim r1", "stuck"], "the second end ends the lend, then marks it stuck");
});

test("a task's slot instructions, the doer's skills, details and outputs go to the agent as info, apart from its instructions", async () => {
  const r = rig([task({ guides: { instructions: { doer: "Keep it short", reviewer: "for the reviewer only" }, skills: { doer: [{ id: "s/brand", name: "brand", hash: "h", checklist: ["names the firm"] }] } }, details: { client: "Jane" }, outputs: ["vyre://s/file/1"] })]);
  await r.onEvent(created("t1"));
  assert.deepEqual(r.woke[0].info, { instructions: "Keep it short", skills: [{ name: "brand", checklist: ["names the firm"] }], details: { client: "Jane" }, outputs: ["vyre://s/file/1"] });
  const plain = rig([task()]);
  await plain.onEvent(created("t1"));
  assert.equal("info" in plain.woke[0], false, "a task with none of it sends no info");
});

test("an agent holding the reviewer slot is woken once per hand-in when the task enters review, with the task id and the slot; a person in the slot, the doer itself, and an outward approval are not woken", async () => {
  const calls = /** @type {any[]} */ ([]);
  const mk = (/** @type {any} */ t) => createAgentWake({ space: "s", gw: { ask: { get: async () => t, edit: async () => {} } }, chain: () => ({}), clock: () => NOW, log: () => {},
    lendSlot: async (x, agent, slot) => { calls.push(`lend ${x.id} ${agent} ${slot}`); }, bindSlot: async (x, agent, slot, th) => { calls.push(`bind ${slot} ${th}`); }, reclaimSlots: async id => { calls.push(`reclaim ${id}`); },
    callModule: async (tool, input) => { calls.push(tool === "agents.wake" ? { wake: input } : tool); return { thread: "th", already: false }; } });
  const reviewed = task({ state: "in_review", reviewer: { kind: "agent", id: "rev" }, payload: { payload_hash: "abcdef0123456789zz" }, guides: { instructions: { reviewer: "check the tone" }, skills: { reviewer: [{ id: "s/voice", name: "voice", hash: "h", checklist: ["names the firm"] }] } }, details: { client: "Jane" } });
  await mk(reviewed)({ type: "task.in-review", data: { task: { id: "t1" } } });
  assert.equal(calls[0], "lend t1 rev reviewer");
  assert.equal(calls[1].wake.task, "t1#reviewer:abcdef012345");
  assert.equal(calls[1].wake.task_id, "t1");
  assert.equal(calls[1].wake.slot, "reviewer");
  assert.equal(calls[1].wake.agent, "rev");
  assert.deepEqual(calls[1].wake.info, { instructions: "check the tone", skills: [{ name: "voice", checklist: ["names the firm"] }], details: { client: "Jane" } });
  assert.equal(calls[2], "bind reviewer th");
  calls.length = 0;
  await mk(task({ state: "in_review", reviewer: { kind: "person", id: "ana" } }))({ type: "task.in-review", data: { task: { id: "t1" } } });
  await mk(task({ state: "in_review", reviewer: { kind: "agent", id: "juno" } }))({ type: "task.in-review", data: { task: { id: "t1" } } });   // juno is the doer
  await mk(task({ state: "needs_check", checker: { kind: "agent", id: "rev" }, output: { kind: "sent" } }))({ type: "task.needs-check", data: { task: { id: "t1" } } });
  assert.deepEqual(calls, [], "none of those wakes an agent");
  // an internal check by an agent is woken as the approver
  await mk(task({ state: "needs_check", checker: { kind: "agent", id: "rev" }, output: { kind: "note" }, payload: { payload_hash: "ff00" } }))({ type: "task.needs-check", data: { task: { id: "t1" } } });
  assert.equal(calls[0], "lend t1 rev approver");
  assert.equal(calls[1].wake.slot, "approver");
});

test("the end of a review round marks the slot wakes over and takes the hold back", async () => {
  const calls = /** @type {any[]} */ ([]);
  const onEvent = createAgentWake({ space: "s", gw: { ask: { get: async () => task(), edit: async () => {} } }, chain: () => ({}), clock: () => NOW, log: () => {}, reclaimSlots: async id => { calls.push(`reclaim ${id}`); },
    callModule: async (tool, input) => { calls.push(`${tool} ${JSON.stringify(input)}`); return {}; } });
  await onEvent({ type: "task.changes-requested", data: { task: { id: "t1" } } });
  assert.deepEqual(calls, ['agents.wake-done {"task":"t1","slots":true}', "reclaim t1"]);
});

test("changes requested on a task whose doer is an agent wakes the doer again with the reviewer's answer as information, in a job of its own, and re-binds its hold to the new thread", async () => {
  const calls = /** @type {any[]} */ ([]);
  const t = task({ state: "changes_requested", review: { by: { kind: "agent", id: "rev" }, type: "agent", result: "changes", checklist: [{ skill: "s/voice", item: "names the firm", ok: false }], at: 7 }, review_note: "add the Rivera figures" });
  const onEvent = createAgentWake({ space: "s", gw: { ask: { get: async () => t, edit: async () => {} } }, chain: () => ({}), clock: () => NOW, log: () => {},
    lend: async x => { calls.push(`lend ${x.id}`); }, bind: async (x, th) => { calls.push(`bind ${th}`); }, reclaimSlots: async id => { calls.push(`reclaim ${id}`); },
    callModule: async (tool, input) => { calls.push(tool === "agents.wake" ? { wake: input } : tool); return { thread: "th2", already: false, rounds: 1 }; } });
  await onEvent({ type: "task.changes-requested", data: { task: { id: "t1" } } });
  const wake = calls.find(c => c && c.wake);
  assert.equal(wake.wake.slot, "changes");
  assert.equal(wake.wake.task, "t1#changes:7");
  assert.equal(wake.wake.task_id, "t1");
  assert.equal(wake.wake.agent, "juno");
  assert.equal(wake.wake.info.review.note, "add the Rivera figures");
  assert.deepEqual(wake.wake.info.review.checklist, [{ skill: "s/voice", item: "names the firm", ok: false }]);
  assert.ok(calls.indexOf("lend t1") < calls.indexOf(wake) && calls.indexOf(wake) < calls.indexOf("bind th2"), "lent first, woken, then held to the new thread");
  // a task whose doer is a person is not woken for it
  const person = createAgentWake({ space: "s", gw: { ask: { get: async () => task({ state: "changes_requested", doer: { kind: "person", id: "ana" } }), edit: async () => {} } }, chain: () => ({}), clock: () => NOW, log: () => {}, lend: async () => { throw new Error("no"); }, callModule: async () => ({}) });
  await person({ type: "task.changes-requested", data: { task: { id: "t1" } } });
});

test("an agent doer and an agent reviewer that go round five times are stopped: no wake after the cap, and a person is given the task once", async () => {
  let now = NOW, rounds = 0, state = "ready";
  const wakes = /** @type {string[]} */ ([]), asked = /** @type {any[]} */ ([]);
  const t = () => task({ state, reviewer: { kind: "agent", id: "rev" }, payload: { payload_hash: `h${now}${"x".repeat(12)}` }, review: { result: "changes", checklist: [], at: now } });
  const onEvent = createAgentWake({ space: "s", gw: { ask: { get: async () => t(), edit: async () => {}, request: async (_c, spec, o) => { asked.push({ spec, o }); return {}; } } }, chain: () => ({}), clock: () => now, log: () => {},
    lend: async () => {}, bind: async () => {}, lendSlot: async () => {}, bindSlot: async () => {}, reclaimSlots: async () => {},
    callModule: async (tool, input) => { if (tool === "agents.wake") { wakes.push(input.slot); if (input.slot === "reviewer") rounds++; return { thread: "th", already: false }; } if (tool === "agents.wake-rounds") return { rounds }; return {}; } });
  for (let i = 0; i < 7; i++) {
    now += 10_000; state = "in_review";
    await onEvent({ type: "task.in-review", data: { task: { id: "t1" } } });
    now += 10_000; state = "changes_requested";
    await onEvent({ type: "task.changes-requested", data: { task: { id: "t1" } } });
  }
  assert.equal(wakes.filter(s => s === "reviewer").length, 5, "five review rounds, no more");
  assert.equal(wakes.filter(s => s === "changes").length, 4, "the doer is woken for the changes of the first four rounds, then the cap holds it");
  assert.equal(asked.length >= 1, true, "a person is told");
  assert.equal(asked[0].spec.doer.id, "ana");
  assert.equal(asked[0].o.idem, "review-cap:t1", "told once, however often the events come");
});
