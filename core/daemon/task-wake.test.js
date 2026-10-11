// @ts-check
// G08: an agent teammate does the task it is given. A real vyred on the fake claude, the kernel on: a task whose doer is a teammate agent wakes it with no call from anyone, the agent's reply is
// handed in as the result, and a person with no AI account of their own makes the task stuck instead of running it on someone else's.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./index.js";
import { tempHome, present, kernelCaller, putOnTask } from "../../test/helpers.js";
import { createTaskWakeHost, briefOf } from "./task-wake.js";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const until = async (/** @type {() => Promise<any>} */ fn, /** @type {string} */ what, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };

/** A vyred in a temp home on the fake claude, the kernel on, one project. */
async function boot(/** @type {any} */ t) {
  const root = fs.realpathSync(tempHome(t));
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_LOG: log, VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: path.join(root, "projects") }));
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: m => logs.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const kcall = kernelCaller(d, root);
  const made = await kcall("projects.create", { name: "Harlow Legal" });
  assert.ok(!made.error, JSON.stringify(made));
  const project = { slug: "harlow-legal" };
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { d, root, project, launches, logs };
}

test("a task given to a teammate agent is done with no one asking: the agent works it and its reply is handed in", { timeout: 120_000 }, async t => {
  const { d, root, project, launches, logs } = await boot(t);
  const kcall = kernelCaller(d, root);
  const made = await kcall("agents.create", { name: "kit", projects: [project.slug] });
  assert.ok(!made.error, JSON.stringify(made));
  await putOnTask(d, root, "kit", project.slug);   // the team row, the grant and one task for kit in this project, as a template makes them
  const dump = async () => { const r = await kcall("tasks.list", {}); return JSON.stringify({ tasks: (r.data.tasks || []).map((/** @type {any} */ x) => [x.title, x.state, x.stuck && x.stuck.reason]), ledger: (() => { try { return fs.readdirSync(path.join(root, "task-wake")).map(f => fs.readFileSync(path.join(root, "task-wake", f), "utf8")); } catch { return "none"; } })(), logs: logs.filter(l => /task-wake|agents:|wake/i.test(l)).slice(-6) }); };
  const done = await until(async () => {
    const r = await kcall("tasks.list", {});
    const mine = (r.data.tasks || []).filter((/** @type {any} */ x) => /^Work for /.test(x.title));
    return mine.length && ["needs_check", "done"].includes(mine[0].state) ? mine[0] : null;
  }, "the task to be handed in", 30_000).catch(async e => { throw new Error(`${e.message}: ${await dump()}`); });
  assert.ok(["needs_check", "done"].includes(done.state));
  assert.ok(launches().length >= 1, "the agent's turn was started on the fake claude");
});

test("the brief names the task and the way to answer", () => {
  const b = briefOf({ title: "Draft the intake form", note: "Four steps.", project: "Harlow Legal" });
  assert.match(b, /Harlow Legal/);
  assert.match(b, /Draft the intake form/);
  assert.match(b, /STUCK:/);
});

/** A Space's kernel pieces, faked: one task, the calls the wake makes. */
function rig(/** @type {{ limit?: number, now?: () => number, root?: string, ledgerState?: any, agentsWork?: (i: any) => Promise<any>, task?: any, onTeam?: boolean, reply?: string }} */ o = {}) {
  const calls = /** @type {string[]} */ ([]);
  const handlers = /** @type {Record<string, (e: any) => any>} */ ({});
  const task = o.task || { id: "tsk_1", state: "ready", title: "Write the letter", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" };
  const gw = {
    ask: {
      get: async () => task,
      start: async (_c, id) => { calls.push(`start ${id}`); task.state = "working"; },
      complete: async (_c, id, ev) => { calls.push(`complete ${id} ${ev.note}`); task.state = "done"; },
      stuck: async (_c, id, x) => { calls.push(`stuck ${id} ${x.reason}`); task.state = "stuck"; },
    },
    records: { query: async () => ({ rows: o.onTeam === false ? [] : [{ data: { actor: { actor: { kind: "agent", id: "agt_kit" } } } }] }) },
  };
  const hear = (/** @type {string} */ type, /** @type {(e: any) => any} */ fn) => { handlers[type] = fn; return () => {}; };
  const host = createTaskWakeHost({
    root: o.root || `/tmp/task-wake-${process.pid}-${Math.random().toString(36).slice(2)}`, hear,
    callModule: async (tool, input) => {
      if (tool === "work.project.ref") return { slug: "p1", name: "P One", urn: "vyre://spc_a/project/p1" };
      if (tool === "agents.list") return [{ uid: "agt_kit", name: "kit" }];
      if (tool === "agents.work.setting") return { daily_limit: o.limit || null };
      if (tool === "agents.work") { calls.push(`work ${input.person} owner=${input.owner}`); return o.agentsWork ? o.agentsWork(input) : { agent: "kit", thread: "th_1" }; }
      throw new Error(`unexpected ${tool}`);
    },
  });
  let push = (/** @type {any} */ _e) => {};
  const notes = /** @type {any[]} */ ([]);
  const h = host.attach({ space: "spc_a", ...(o.now ? { clock: o.now } : {}), notify: async n => { notes.push(n); }, gw, chains: { fromFacts: (/** @type {any} */ f) => ({ facts: f }) }, ownerChain: () => ({}), ownerId: () => "per_owner", grantWork: { make: async (a, t) => { calls.push(`grant ${a} ${t}`); }, end: async t => { calls.push(`end ${t}`); } }, subscribe: cb => { push = cb; return () => {}; } });
  const ready = (/** @type {string} */ type = "task.created") => push({ type, data: { state: "ready", task } });
  const finish = async (/** @type {string} */ text) => { handlers["thread.text"]({ thread: "th_1", payload: { text, done: true } }); handlers["thread.finished"]({ thread: "th_1", payload: {} }); await new Promise(r => setTimeout(r, 20)); await h.idle(); };
  return { notes, root: o.root, calls: new Proxy(calls, { get: (a, k) => (k === "at" ? (i) => a.filter(c => !c.startsWith("end ")).at(i) : k === "filter" ? (f) => a.filter(c => !c.startsWith("end ")).filter(f) : k === "length" ? a.filter(c => !c.startsWith("end ")).length : Reflect.get(a, k)) }), task, h, ready, finish };
}

test("one task is woken once, the turn runs on the assigner's account, and the reply is the result", async () => {
  const r = rig();
  r.ready(); r.ready("task.readied");
  await r.h.idle();
  assert.deepEqual(r.calls, ["grant agt_kit tsk_1", "start tsk_1", "work per_bob owner=false"], "started once, on per_bob's account, not the home owner's");
  await r.finish("Letter written and filed.");
  assert.equal(r.calls.at(-1), "complete tsk_1 Letter written and filed.");
});

test("a person with no AI account makes the task stuck, naming whose account is needed, and no one else's runs", async () => {
  const r = rig({ agentsWork: async () => { throw Object.assign(new Error("no AI account"), { code: "account_required" }); } });
  r.ready();
  await r.h.idle();
  assert.match(r.calls.at(-1), /^stuck tsk_1 needs per_bob to connect an AI account$/);
});

test("an agent that is not a teammate of the project is not woken, and a task a person did not give to an agent is left alone", async () => {
  const off = rig({ onTeam: false });
  off.ready(); await off.h.idle();
  assert.deepEqual(off.calls, []);
  const person = rig({ task: { id: "tsk_2", state: "ready", title: "x", doer: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" } });
  person.ready(); await person.h.idle();
  assert.deepEqual(person.calls, []);
});

test("a reply that starts with STUCK: flags the task; a turn that ends with nothing is tried once more, then flagged", async () => {
  const a = rig();
  a.ready(); await a.h.idle();
  await a.finish("STUCK: I need the client's file number.");
  assert.equal(a.calls.at(-1), "stuck tsk_1 I need the client's file number.");
  const b = rig();
  b.ready(); await b.h.idle();
  await b.finish("");
  assert.equal(b.calls.filter(c => c.startsWith("work ")).length, 2, "a second turn was started");
  await b.finish("");
  assert.match(b.calls.at(-1), /^stuck tsk_1 the agent's turn ended without a result/);
});

test("after a restart a task that was being worked gets one more turn, then is flagged; a task already on its second turn is flagged at once", async () => {
  const root = `/tmp/task-wake-restart-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const first = rig({ root });
  first.ready(); await first.h.idle();
  assert.equal(first.calls.filter(c => c.startsWith("work ")).length, 1);
  // the daemon stops with the turn still running; a new one starts on the same ledger, the kernel's task still working
  const second = rig({ root, task: first.task });
  await second.h.recover(); await second.h.idle();
  assert.equal(second.calls.filter(c => c.startsWith("work ")).length, 1, "one more turn after the restart");
  // and it stops again before the turn ends: that was the second turn, so the next start flags it
  const third = rig({ root, task: first.task });
  await third.h.recover(); await third.h.idle();
  assert.match(third.calls.at(-1), /^stuck tsk_1 the server restarted while the agent was working on this$/);
  assert.equal(third.calls.filter(c => c.startsWith("work ")).length, 0, "no third turn");
});

test("a task that was claimed but never started is woken as new after a restart", async () => {
  const root = `/tmp/task-wake-restart2-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const a = rig({ root });
  a.ready(); await a.h.idle();
  a.task.state = "ready";   // the start did not stick before the stop
  const b = rig({ root, task: a.task });
  await b.h.recover(); await b.h.idle();
  assert.deepEqual(b.calls.slice(0, 2), ["grant agt_kit tsk_1", "start tsk_1"]);
});

test("a picked AI account that cannot be used makes the task stuck, naming whose account needs attention, and nothing else runs", async () => {
  const r = rig({ agentsWork: async () => { throw Object.assign(new Error("person:per_alice the AI account picked for agent work in p1 cannot be used"), { code: "account_attention" }); } });
  r.ready(); await r.h.idle();
  assert.equal(r.calls.at(-1), "stuck tsk_1 per_alice's AI account for agent work needs attention");
});

test("the daily limit holds the turns the wake starts by itself: the task waits, the assigner is told once, and it starts again the next day", async () => {
  let now = Date.parse("2026-10-11T10:00:00Z");
  const root = `/tmp/task-wake-limit-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const first = rig({ root, limit: 1, now: () => now });
  first.ready(); await first.h.idle();
  assert.equal(first.calls.filter(c => c.startsWith("work ")).length, 1);
  // a second task in the same project the same day
  const two = { id: "tsk_2", state: "ready", title: "Second", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" };
  const second = rig({ root, limit: 1, now: () => now, task: two });
  second.ready(); await second.h.idle();
  assert.equal(second.calls.filter(c => c.startsWith("work ")).length, 0, "no turn past the limit");
  assert.equal(two.state, "ready", "the task keeps waiting");
  assert.equal(second.notes.length, 1);
  assert.match(second.notes[0].title, /daily limit/);
  assert.equal(second.notes[0].person, "per_bob");
  second.ready(); await second.h.idle();
  assert.equal(second.notes.length, 1, "told once a day");
  now = Date.parse("2026-10-12T10:00:00Z");
  await second.h.resumePaused(); await second.h.idle();
  assert.equal(second.calls.filter(c => c.startsWith("work ")).length, 1, "the next day it starts");
});

test("the AI account for agent work is picked from your own accounts: yours is kept and shown, another's or a made-up one is refused, and a limit can be set", { timeout: 120_000 }, async t => {
  const { d, root, project } = await boot(t);
  const kcall = kernelCaller(d, root);
  assert.ok(!(await kcall("agents.create", { name: "kit", projects: [project.slug] })).error);
  const acct = await kcall("sessions.accounts.add", { provider: "claude", label: "Mine", kind: "login" });
  assert.ok(!acct.error, JSON.stringify(acct));
  const id = acct.data.id;
  const before = await kcall("agents.work.setting", { project: project.slug });
  assert.equal(before.data.account, null, "nothing picked yet");
  const bogus = await kcall("agents.work.set", { project: project.slug, account: "acc_nobody" });
  assert.equal(bogus.error && bogus.error.code, "not_found");
  assert.match(bogus.error.message, /pick one of those/);
  const set = await kcall("agents.work.set", { project: project.slug, account: id, daily_limit: 12 });
  assert.ok(!set.error, JSON.stringify(set));
  assert.equal(set.data.account, id);
  assert.equal(set.data.daily_limit, 12);
  assert.equal(set.data.person, d.kernel.id.owner, "the pick belongs to the person who made it");
  const one = await kcall("agents.work.set", { project: project.slug, agent: "kit", account: id });
  assert.equal(one.data.agent_pick, true, "one teammate can have its own pick");
  const cleared = await kcall("agents.work.set", { project: project.slug, account: null });
  assert.equal(cleared.data.account, null, "the project's pick is cleared");
  assert.equal((await kcall("agents.work.setting", { project: project.slug, agent: "kit" })).data.account, id, "the teammate's own pick stays");
  const none = await kcall("agents.work.set", { project: project.slug, agent: "kit", account: null });
  assert.equal(none.data.account, null);
  const noPerson = await d.registry.call("agents.work.set", { project: project.slug, account: id }, "cli", {});
  assert.ok(noPerson.error, "a call with no person behind it picks nothing");
});
