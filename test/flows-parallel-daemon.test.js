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
  const r = await d.registry.call("flows.define", { flow: { format: 1, name: "weekday_note", label: "Weekday note", authorship: "human", trigger: { on: "time", cron: "0 9 * * 1-5", tz: "America/New_York", hours: true, holidays: ["12-25"], catch_up: "skip" },
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
});
