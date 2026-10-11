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
import { createTaskWakeHost, briefOf, taskGrantSpec, classifyRefusal } from "./task-wake.js";

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
function rig(/** @type {{ report?: number | null, say?: any, lead?: string, others?: any[], limit?: number, now?: () => number, root?: string, ledgerState?: any, agentsWork?: (i: any) => Promise<any>, task?: any, onTeam?: boolean, reply?: string }} */ o = {}) {
  const calls = /** @type {string[]} */ ([]);
  const fixes = /** @type {string[]} */ ([]);
  const handlers = /** @type {Record<string, (e: any) => any>} */ ({});
  const task = o.task || { id: "tsk_1", state: "ready", title: "Write the letter", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" };
  const gw = {
    ask: {
      get: async (_c, id) => [task, ...(o.others || [])].find(x => x.id === id) || null,
      start: async (_c, id) => { calls.push(`start ${id}`); task.state = "working"; },
      complete: async (_c, id, ev) => { calls.push(`complete ${id} ${ev.note}`); task.state = "done"; },
      list: async () => o.others || [],
      request: async (_c, spec) => { calls.push(`request ${spec.title}`); },
      unblock: async (_c, id, x) => { calls.push(`unblock ${id} ${x.reassign_to.id}`); },
      stuck: async (_c, id, x) => { calls.push(`stuck ${id} ${x.reason}`); fixes.push(x.suggested_fix); task.state = "stuck"; },
    },
    records: {
      query: async (_c, type) => type === "project" ? { rows: o.projects || [] } : ({ rows: o.onTeam === false ? [] : [{ data: { role: "lead", actor: { actor: { kind: "agent", id: "agt_kit" } } } }, { data: { role: "design", actor: { actor: { kind: "agent", id: "agt_dana" } } } }] }),
      get: async () => ({ data: { lead: o.lead || "" } }),
    },
  };
  const hear = (/** @type {string} */ type, /** @type {(e: any) => any} */ fn) => { handlers[type] = fn; return () => {}; };
  const host = createTaskWakeHost({
    root: o.root || `/tmp/task-wake-${process.pid}-${Math.random().toString(36).slice(2)}`, hear,
    callModule: async (tool, input) => {
      if (tool === "work.project.ref") return { id: "p1id", slug: "p1", name: "P One", urn: "vyre://spc_a/project/p1" };
      if (tool === "agents.list") return [{ uid: "agt_kit", name: "kit" }, { uid: "agt_dana", name: "dana" }];
      if (tool === "agents.work.setting") return { daily_limit: o.limit || null, report_hours: o.report === undefined ? null : o.report };
      if (tool === "agents.work") { calls.push(`work ${input.person} owner=${input.owner}`); return o.agentsWork ? o.agentsWork(input) : { agent: "kit", thread: "th_1" }; }
      throw new Error(`unexpected ${tool}`);
    },
  });
  let push = (/** @type {any} */ _e) => {};
  const notes = /** @type {any[]} */ ([]);
  const h = host.attach({ space: "spc_a", ...(o.now ? { clock: o.now } : {}), notify: async n => { notes.push(n); },
    ...(o.say ? { say: o.say } : {}), gw, chains: { fromFacts: (/** @type {any} */ f) => ({ facts: f }) }, ownerChain: () => ({}), ownerId: () => "per_owner", grantWork: { make: async (a, t) => { calls.push(`grant ${a} ${t}`); }, end: async t => { calls.push(`end ${t}`); } }, subscribe: cb => { push = cb; return () => {}; } });
  const ready = (/** @type {string} */ type = "task.created") => push({ type, data: { state: "ready", task } });
  const finish = async (/** @type {string} */ text, /** @type {any} */ fin = {}) => { handlers["thread.text"]({ thread: "th_1", payload: { text, done: true } }); handlers["thread.finished"]({ thread: "th_1", payload: fin }); await new Promise(r => setTimeout(r, 20)); await h.idle(); };
  return { opts: o, raw: calls, fixes, notes, root: o.root, calls: new Proxy(calls, { get: (a, k) => (k === "at" ? (i) => a.filter(c => !c.startsWith("end ")).at(i) : k === "filter" ? (f) => a.filter(c => !c.startsWith("end ")).filter(f) : k === "length" ? a.filter(c => !c.startsWith("end ")).length : Reflect.get(a, k)) }), task, h, ready, finish };
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
  const r = rig({ agentsWork: async () => { throw Object.assign(new Error("person:per_alice kind:removed the AI account picked for agent work in p1 cannot be used"), { code: "account_attention" }); } });
  r.ready(); await r.h.idle();
  assert.equal(r.calls.at(-1), "stuck tsk_1 per_alice's AI account for agent work needs attention (account removed or not usable)".replace("per_alice", "per_alice"));
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

test("a failed launch says what failed: sign-in refused, quota, removed or other, each with its own next step", async () => {
  for (const [kind, word, fix] of [["auth", "sign-in refused", /Sign in to the account again/], ["quota", "out of quota or rate limited", /quota/], ["other", "start failed", /Check the account/]]) {
    const r = rig({ agentsWork: async () => { throw Object.assign(new Error(`person:per_bob kind:${kind} the AI account cannot be used`), { code: "account_attention" }); } });
    r.ready(); await r.h.idle();
    assert.equal(r.calls.at(-1), `stuck tsk_1 per_bob's AI account for agent work needs attention (${word})`);
    assert.match(r.fixes.at(-1), fix);
  }
});

test("the grant names one task and one agent and two actions, nothing more", () => {
  const g = taskGrantSpec("spc_a", "agt_kit", "tsk_1", 123);
  assert.deepEqual(g.subject, { kind: "actor", actor: { kind: "agent", id: "agt_kit", space: "spc_a" } });
  assert.deepEqual(g.actions, ["tasks.read", "tasks.work"]);
  assert.deepEqual(g.resource, { prefix: "vyre://spc_a/task/tsk_1" });
  assert.deepEqual(g.conditions, { when: { expires: 123 } });
  assert.equal(g.source, "task-wake:tsk_1");
});

test("the grant is ended when the task goes to another doer, and when it is no longer working", async () => {
  const r = rig();
  r.ready(); await r.h.idle();
  r.task.doer = { kind: "agent", id: "agt_other" };
  await r.h.sweep(); await r.h.idle();
  assert.ok(r.raw.includes("end tsk_1"), "ended on reassignment");
  assert.ok(!r.calls.some(c => c.startsWith("stuck")), "and not flagged: it is no longer this agent's task");
  const q = rig();
  q.ready(); await q.h.idle();
  q.task.state = "skipped";
  await q.h.sweep(); await q.h.idle();
  assert.ok(q.raw.includes("end tsk_1"), "ended when the task moved on");
});

test("an agent that leaves the team or a project that is gone has its task flagged first, then the grant ended", async () => {
  const r = rig();
  r.ready(); await r.h.idle();
  r.opts.onTeam = false;
  await r.h.sweep(); await r.h.idle();
  const stuckAt = r.raw.findIndex(c => c.startsWith("stuck tsk_1 the agent is no longer a teammate")), endAt = r.raw.lastIndexOf("end tsk_1");
  assert.ok(stuckAt >= 0, "flagged with a reason");
  assert.ok(endAt > stuckAt, "the grant is ended after the flag, which needs it");
});

test("a task still working when the six hours run out is flagged stuck with a reason, not left without reach; a restart makes a fresh grant", async () => {
  let now = Date.parse("2026-10-11T10:00:00Z");
  const root = `/tmp/task-wake-expiry-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = rig({ root, now: () => now });
  r.ready(); await r.h.idle();
  now += 7 * 3600_000;
  await r.h.sweep(); await r.h.idle();
  assert.equal(r.calls.at(-1), "stuck tsk_1 the agent's time on this task ran out");
  assert.ok(r.raw.includes("end tsk_1"));
  // a restart on a task still working: the old grant is ended and a fresh one made before the turn
  const root2 = `/tmp/task-wake-fresh-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const a = rig({ root: root2 });
  a.ready(); await a.h.idle();
  const b = rig({ root: root2, task: a.task });
  await b.h.recover(); await b.h.idle();
  const i = b.raw.indexOf("end tsk_1"), j = b.raw.indexOf("grant agt_kit tsk_1"), k = b.raw.findIndex(c => c.startsWith("work "));
  assert.ok(i >= 0 && j > i && k > j, `end, then a fresh grant, then the turn: ${b.raw.join(" | ")}`);
});

test("with its grant an agent works that task and no other: not a second task in the same project, not a task of another project, and not this one after the grant ends", { timeout: 120_000 }, async t => {
  const { d, root, project } = await boot(t);
  const kcall = kernelCaller(d, root);
  assert.ok(!(await kcall("projects.create", { name: "Other Co" })).error);
  const made = await kcall("agents.create", { name: "kit", projects: [project.slug, "other-co"] });
  assert.ok(!made.error, JSON.stringify(made));   // kit is a member of the Space but NOT a teammate of either project: the wake leaves these tasks alone
  const uid = String((await d.registry.call("agents.uid", { name: "kit" }, "module:projects")).data.uid);
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  try { await d.kernel.gateway.grants.addActor(admin, { kind: "agent", id: uid, space }, { presence: { method: "stand-in" } }); } catch { /* already an actor */ }
  const mk = async (/** @type {string} */ proj, /** @type {string} */ title, /** @type {any} */ extra = {}) => {
    const ref = await kcall("work.project.ref", { project: proj });
    const r = await kcall("tasks.request", { task: { title, output: { kind: "note" }, doer: uid, checker: owner, project: ref.data.urn, ...extra } });
    assert.ok(!r.error, JSON.stringify(r));
    return String(r.data.task.id);
  };
  const a = await mk(project.slug, "A");
  const b = await mk(project.slug, "B", { depends_on: [a] });   // waiting, same project
  const c = await mk("other-co", "C");                           // ready, another project
  const handle = d.kernel.kernelFor({ name: "task-wake", needs: { kernel: { actions: [], mints: [{ prefix: "task", actions: ["tasks.read", "tasks.work"] }] } } });
  await handle.mint.make(taskGrantSpec(space, uid, a, Date.now() + 3600_000));
  const agent = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: uid, session: "wake-a" });
  const ask = d.kernel.gateway.ask;
  await assert.rejects(() => ask.start(agent, b), "not a second task of the same project");
  await assert.rejects(() => ask.start(agent, c), "not a task of another project");
  // the grant is for one address: task ids are fixed-length (the kernel mints them), and an address that merely begins with this task's id is not this task
  assert.equal(a.length, b.length, "ids are fixed-length");
  const at = (/** @type {string} */ res) => d.kernel.gateway.authorize({ chain: agent, action: "tasks.work", resource: res });
  assert.equal((await at(`vyre://${space}/task/${a}`)).effect, "allow", "the task itself");
  assert.notEqual((await at(`vyre://${space}/task/${a}0`)).effect, "allow", "an id that extends it is another task");
  assert.notEqual((await at(`vyre://${space}/task/${a.slice(0, -1)}`)).effect, "allow", "and a shorter one is not this task either");
  await ask.start(agent, a);   // the one it was given
  await handle.mint.end({ source: `task-wake:${a}`, reason: "test" });
  await assert.rejects(() => ask.complete(agent, a, { note: "done", sources: ["s"] }), "and not this one once the grant has ended");
});

test("an empty turn whose provider said quota or sign-in is stuck with that word, at once, not retried", async () => {
  assert.equal(classifyRefusal("429 rate limit exceeded"), "quota");
  assert.equal(classifyRefusal("401 Unauthorized: invalid API key"), "auth");
  assert.equal(classifyRefusal("something odd"), "");
  const q = rig();
  q.ready(); await q.h.idle();
  await q.finish("", { ok: false, error: "Claude usage limit reached" });
  assert.equal(q.calls.at(-1), "stuck tsk_1 per_bob's AI account for agent work needs attention (out of quota or rate limited)");
  assert.equal(q.calls.filter(c => c.startsWith("work ")).length, 1, "no second turn on a refused account");
  const a = rig();
  a.ready(); await a.h.idle();
  await a.finish("", { ok: false, error: "401 Unauthorized" });
  assert.match(a.calls.at(-1), /\(sign-in refused\)$/);
});

const stuckTask = (/** @type {string} */ id, /** @type {any} */ extra = {}) => ({ id, state: "stuck", title: `Draft ${id}`, doer: { kind: "agent", id: "agt_kit" }, project: "vyre://spc_a/project/p1", stuck: { reason: "no template" }, ...extra });

test("the project lead's plan names the team and the tasks without ids, and its reply is the plan the person reads", async () => {
  const said = /** @type {any[]} */ ([]);
  const plan = { id: "tsk_plan", state: "ready", title: "Plan P One", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" };
  const r = rig({ lead: "kit", task: plan, others: [stuckTask("tsk_9")], say: async (m) => { said.push(m); } });
  r.ready(); await r.h.idle();
  await r.finish("First Dana drafts the intake form, then I check it. I need the client's file number.");
  const done = r.calls.at(-1);
  assert.match(done, /^complete tsk_plan First Dana drafts the intake form/);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /First Dana drafts/);
  assert.doesNotMatch(said[0].text, /tsk_/);
});

test("the lead recommends moving a stuck task to a teammate whose role fits, once; anything else is flagged to the person; nothing is moved", async () => {
  const mk = () => ({ id: "tsk_rep", state: "ready", title: "Report on P One", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" });
  const r = rig({ lead: "kit", task: mk(), others: [stuckTask("tsk_9"), stuckTask("tsk_8", { doer: { kind: "person", id: "per_x" } })] });
  r.ready(); await r.h.idle();
  await r.finish('Two things are stuck.\nREASSIGN: {"picks":[{"task":1,"to":"design"},{"task":2,"to":"design"},{"task":1,"to":"nobody"}]}');
  assert.ok(!r.calls.some(c => c.startsWith("unblock")), "nothing is moved: the lead only recommends");
  assert.ok(!r.calls.some(c => c.startsWith("unblock tsk_8")), "a task a person has is not moved");
  const note = r.calls.at(-1);
  assert.match(note, /I recommend moving "Draft tsk_9" to dana/);
  assert.match(note, /a person has it/);
  assert.match(note, /no one else on the team holds the role nobody/);
});

test("a task already stuck twice is not moved by the lead, and an unreadable list of moves makes none", async () => {
  const task = (/** @type {string} */ id) => ({ id, state: "ready", title: "Report on P One", doer: { kind: "agent", id: "agt_kit" }, assigned_by: { kind: "person", id: "per_bob" }, project: "vyre://spc_a/project/p1" });
  // stuck twice: the daemon's own count for tsk_9 is already 2
  const root = `/tmp/task-wake-lead-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fs = await import("node:fs");
  fs.mkdirSync(`${root}/task-wake`, { recursive: true });
  fs.writeFileSync(`${root}/task-wake/spc_a.json`, JSON.stringify({ tasks: { tsk_9: { state: "stuck", stuckTimes: 2 } }, days: {}, reports: {} }));
  const twice = rig({ root, lead: "kit", task: task("tsk_r1"), others: [stuckTask("tsk_9")] });
  twice.ready(); await twice.h.idle();
  await twice.finish('Stuck.\nREASSIGN: {"picks":[{"task":1,"to":"design"}]}');
  assert.ok(!twice.calls.some(c => c.startsWith("unblock")));
  assert.match(twice.calls.at(-1), /it has been stuck twice\. It needs you\./);
  const bad = rig({ lead: "kit", task: task("tsk_r2"), others: [stuckTask("tsk_9")] });
  bad.ready(); await bad.h.idle();
  await bad.finish("Stuck.\nREASSIGN: {not json");
  assert.ok(!bad.calls.some(c => c.startsWith("unblock")));
  assert.match(bad.calls.at(-1), /could not read my own list of moves/);
});

test("the report is a duty: asked for once a day per project with a lead, not at first sight, not when off, not twice", async () => {
  let now = Date.parse("2026-10-11T10:00:00Z");
  const projects = [{ id: "p1id", urn: "vyre://spc_a/project/p1", data: { slug: "p1", name: "P One", lead: "kit" } }];
  const root = `/tmp/task-wake-report-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = rig({ root, now: () => now, projects });
  await r.h.reports(); await r.h.idle();
  assert.deepEqual(r.calls.filter(c => c.startsWith("request")), [], "first sight only marks the project: the plan is its first word");
  now += 23 * 3600_000; await r.h.reports(); await r.h.idle();
  assert.deepEqual(r.calls.filter(c => c.startsWith("request")), [], "not before a day has passed");
  now += 2 * 3600_000; await r.h.reports(); await r.h.idle();
  assert.deepEqual(r.calls.filter(c => c.startsWith("request")), ["request Report on P One"]);
  await r.h.reports(); await r.h.idle();
  assert.equal(r.calls.filter(c => c.startsWith("request")).length, 1, "not twice in a day");
  const off = rig({ root: `${root}-off`, now: () => now, projects, report: 0 });
  await off.h.reports(); now += 48 * 3600_000; await off.h.reports(); await off.h.idle();
  assert.deepEqual(off.calls.filter(c => c.startsWith("request")), [], "off means off");
});

test("the project lead's message is the daemon's alone, for the project's flagged lead alone, and says no when the project has no chat", { timeout: 120_000 }, async t => {
  const { d, root, project } = await boot(t);
  const kcall = kernelCaller(d, root);
  assert.ok(!(await kcall("agents.create", { name: "kit", projects: [project.slug] })).error);
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const ref = (await kcall("work.project.ref", { project: project.slug })).data;
  const say = (/** @type {string} */ caller, /** @type {any} */ input) => d.registry.call("work.project.say", { project: project.slug, text: "Plan: Dana drafts first.", ...input }, caller);
  const person = await say("cli", { agent: "kit" });
  assert.equal(person.error && person.error.code, "no_such_tool", "it is not a person's tool or an agent's: they cannot even see it");
  const noLead = await say("module:vyred", { agent: "kit" });
  assert.equal(noLead.error && noLead.error.code, "denied", "a project with no flagged lead gets nothing");
  const rec = await d.kernel.gateway.records.get(admin, "project", ref.id);
  await d.kernel.gateway.records.update(admin, "project", ref.id, { lead: "kit" }, rec.version);
  const other = await say("module:vyred", { agent: "someone" });
  assert.equal(other.error && other.error.code, "denied", "an agent that is not the lead posts nothing");
  const none = await say("module:vyred", { agent: "kit" });
  assert.ok(!none.error, JSON.stringify(none));
  assert.equal(none.data.posted, false, "no chat: the words stay as the task's result");
  const sayAs = await d.registry.call("threads.say-as", { thread: "nope", agent: "kit", text: "x" }, "module:vyred");
  assert.equal(sayAs.error && sayAs.error.code, "denied", "and the thread line can only be written by the work module");
});
