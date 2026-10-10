// @ts-check
// Parallel lanes and sub-flows in a REAL vyred (kernel on, Flows on records): a Flow splits into a lane that waits for a person and a lane that runs another Flow; the server stops and starts
// again while the person has not answered; the answer finishes the run, and the step after the join uses what the sub-flow returned. Also: a schedule with business hours in the Space's zone.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const NOTE = { name: "filing-note", label: "Filing note", fields: [{ name: "body", kind: "text", label: "Body" }] };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("lanes and a sub-flow in a real daemon: a restart while a lane waits for a person loses nothing, and the answer finishes the run", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop().catch(() => {}));
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const host = () => d.registry.deps.flowsHost.get(space);
  const chainOf = () => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chainOf(), {})).token });
  await d.kernel.gateway.records.define(chainOf(), { add_types: [NOTE] });
  const install = async (/** @type {any} */ flow) => {
    const r = await d.registry.call("flows.define", { flow }, "cli", await meta());
    assert.ok(r.data && r.data.ok, JSON.stringify(r));
    await host().flows.tools["flows.approve"](host().personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  await install({ format: 1, name: "inner_note", label: "Write the inner note", authorship: "human", trigger: { on: "manual" }, returns: { body: { expr: "steps.c.record.data.body" } },
    steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: { expr: "\"inner for \" + trigger.client" } } }] });
  const outer = await install({ format: 1, name: "file_it", label: "File it", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "p", kind: "parallel", steps: [
      { id: "review", kind: "branch", steps: [{ id: "look", kind: "assign", to: `person:${owner}`, title: "Look it over", output: { kind: "decision" }, how: "person", await: true }] },
      { id: "draft", kind: "branch", steps: [{ id: "s", kind: "subflow", flow: "inner_note", input: { client: { expr: "trigger.client" } } }] },
    ] },
    { id: "after", kind: "create", type: "filing-note", set: { body: { expr: "\"after: \" + steps.s.result.body" } } },
  ] });

  const graph = (await d.registry.call("flows.graph", { id: outer.id }, "cli", await meta())).data;
  assert.equal(graph.nodes.find((/** @type {any} */ n) => n.id === "s").label, 'Run the Flow "Write the inner note"', "the sub-flow step reads with the other Flow's label, never its id");

  const started = await host().flows.tools["flows.start"](host().personChain(), { id: outer.id, input: { client: "Rivera" } });
  const runId = started.run || started.id;
  const state = async () => (await d.registry.call("flows.run", { run: runId }, "cli", await meta())).data;
  const waiting = await until(async () => { const r = await state(); return r && r.run.state === "waiting" && r.lanes && r.lanes.length === 2 && r.lanes.some(l => l.lane === "draft" && l.state === "done") ? r : null; }, "the parent to wait on a person while the sub-flow lane finishes");
  assert.equal(waiting.run.waiting.kind, "children");
  const notes = async () => ((await d.kernel.gateway.records.query(chainOf(), "filing-note", { page: { limit: 20 } })).rows || []).map((/** @type {any} */ r) => r.data.body).sort();
  assert.deepEqual(await notes(), ["inner for Rivera"], "the sub-flow ran; the step after the join has not");

  // the server stops and starts again with the lane still waiting
  await d.stop();
  d = await start({ root, presence: present, log: () => {}, kernel: true });
  const again = await until(async () => { const r = await state(); return r && r.run.state === "waiting" ? r : null; }, "the run to be waiting after the restart");
  assert.equal(again.lanes.length, 2, "no lane was started twice");

  const task = await until(async () => (await d.kernel.gateway.ask.list(chainOf(), { state: ["waiting", "ready", "working", "needs_check", "stuck"] })).find((/** @type {any} */ x) => x.title === "Look it over"), "the person's task");
  assert.equal(task.flow, outer.id, "the task names the Flow that gave it (it once read \"[object Object]\")");
  await d.kernel.gateway.ask.start(chainOf(), task.id);
  await d.kernel.gateway.ask.complete(chainOf(), task.id, { answer: "yes", reason: "looks fine" });
  const done = await until(async () => { const r = await state(); return r && r.run.state === "done" ? r : r && r.run.state === "failed" ? assert.fail(JSON.stringify(r.run.error)) : null; }, "the run to finish after the answer");
  assert.deepEqual(await notes(), ["after: inner for Rivera", "inner for Rivera"], "the step after the join used what the sub-flow returned, once");
  assert.deepEqual(done.lanes.map((/** @type {any} */ l) => l.state), ["done", "done"]);
});

test("a schedule with business hours in a real daemon: the health line and the next wake name the next open time, off the Space's holidays", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const token = (await d.kernel.surfaces.open(chain, {})).token;
  await d.kernel.gateway.records.define(chain, { add_types: [NOTE] });
  const r = await d.registry.call("flows.define", { flow: { format: 1, name: "weekday_note", label: "Weekday note", authorship: "human", trigger: { on: "time", cron: "0 9 * * 1-5", tz: "America/New_York", hours: true, catch_up: "skip" },
    steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: "hi" } }] } }, "cli", { token });
  assert.ok(r.data && r.data.ok, JSON.stringify(r));
  await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
  const wake = await host.flows.runner.nextWake();
  assert.ok(wake && wake > Date.now() - 60_000, "there is a next time");
  const at = new Date(wake);
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(at);
  const part = (/** @type {string} */ k) => ny.find(p => p.type === k)?.value;
  assert.ok(["Mon", "Tue", "Wed", "Thu", "Fri"].includes(String(part("weekday"))), `a weekday (${part("weekday")})`);
  assert.equal(Number(part("hour")) % 24, 9, "at 9:00 New York");
  const health = (await d.registry.call("flows.health", { id: r.data.id }, "cli", { token })).data;
  assert.ok(health, "the Flow has a health line");

  // the Space's holiday list (Settings, Flows) keeps that day off: the next time moves on to the next open weekday
  const day = (/** @type {number} */ ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const set = await d.registry.call("settings.set", { key: "flows.holidays", value: day(wake) }, "cli", { token });
  assert.ok(!set.error, JSON.stringify(set.error));
  await host.flows.tick();
  const moved = await host.flows.runner.nextWake();
  assert.ok(moved && moved > wake, `the holiday moved the next time on (${day(wake)} -> ${moved && day(moved)})`);
  assert.notEqual(day(moved), day(wake));
});

test("try it on last week in a real daemon: the window picks the real events, and the replay matches what the Flow really did", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const token = (await d.kernel.surfaces.open(chain, {})).token;
  const CONTACT = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "status", kind: "text", label: "Status" }] };
  await d.kernel.gateway.records.define(chain, { add_types: [CONTACT, NOTE] });
  const r = await d.registry.call("flows.define", { flow: { format: 1, name: "mark_seen", label: "Mark seen", authorship: "human", trigger: { on: "event", event: "contact.created" },
    steps: [{ id: "u", kind: "update", type: "contact", record: { expr: "event.subject" }, set: { status: "seen" } }] } }, "cli", { token });
  assert.ok(r.data && r.data.ok, JSON.stringify(r));
  await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
  const before = Date.now() - 60_000;
  for (const name of ["Jane", "Joe"]) await d.kernel.gateway.records.create(chain, "contact", { name });
  await until(async () => { const runs = (await d.registry.call("flows.runs", { id: r.data.id }, "cli", { token })).data || []; return runs.length === 2 && runs.every((/** @type {any} */ x) => x.state === "done") ? runs : null; }, "both runs to finish");

  const sim = (await d.registry.call("flows.simulate", { id: r.data.id, since: before, until: Date.now() + 60_000 }, "cli", { token })).data;
  assert.equal(sim.ok, true, JSON.stringify(sim.errors));
  assert.equal(sim.matched, 2, "the window held the two real events");
  assert.equal(sim.history.matches, true, sim.history.line);
  assert.deepEqual([sim.history.ran, sim.history.would, sim.history.same], [2, 2, 2]);
  const later = (await d.registry.call("flows.simulate", { id: r.data.id, since: Date.now() + 3_600_000 }, "cli", { token })).data;
  assert.equal(later.matched, 0, "a window in the future holds nothing");
});

test("a short wait in a real daemon resumes when it is due, not at the timer's next minute", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const token = (await d.kernel.surfaces.open(chain, {})).token;
  await d.kernel.gateway.records.define(chain, { add_types: [NOTE] });
  // let the timer settle into its long sleep, as it does on a quiet server
  await new Promise(r => setTimeout(r, 2500));
  const r = await d.registry.call("flows.define", { flow: { format: 1, name: "short_wait", label: "Short wait", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "w", kind: "wait", for_ms: 3000 }, { id: "c", kind: "create", type: "filing-note", set: { body: "after the wait" } }] } }, "cli", { token });
  assert.ok(r.data && r.data.ok, JSON.stringify(r));
  await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
  const t0 = Date.now();
  await host.flows.tools["flows.start"](host.personChain(), { id: r.data.id, input: {} });
  await until(async () => ((await d.registry.call("flows.runs", { id: r.data.id }, "cli", { token })).data || []).some((/** @type {any} */ x) => x.state === "done"), "the run to finish after its 3 second wait", 30_000);
  assert.ok(Date.now() - t0 < 30_000, `it took ${Date.now() - t0} ms (the timer's minute-long sleep made it up to 60 s)`);
});
