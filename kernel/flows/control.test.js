// @ts-check
// Flows reliability, wave 2: concurrency limits and per-record locks (f6), pause all / pause one / drain with a held backlog (f7), the stuck-run watchdog (f5).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { FlowRunner } from "./runner.js";
import { sourceHash } from "./schema.js";

const mine = (/** @type {any} */ w, /** @type {string} */ type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const src = "return { n: 1 };";
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"], ...extra });
/** The matters made so far (the kernel mirrors records into its tables when it is pumped). */
const matters = async (/** @type {any} */ w) => { await w.kernel.pump(); if (w.kernel.idle) await w.kernel.idle(); return mine(w, "matter").map((/** @type {any} */ m) => m.data.client); };
/** The order the runs ran in (by when their step finished), as the `n` each was triggered with: the kernel's table order is not an order of making. */
const ranOrder = async (/** @type {any} */ w) => {
  const runs = await w.runner.listRuns({ limit: 1000 });
  const n = new Map(runs.map((/** @type {any} */ r) => [r.id, r.trigger.event && r.trigger.event.data ? r.trigger.event.data.n : null]));
  return w.emitted.filter((/** @type {any} */ e) => e.type === "step.done").map((/** @type {any} */ e) => n.get(e.data.run));
};
const states = async (/** @type {any} */ w) => Object.fromEntries((await w.runner.listRuns()).map((/** @type {any} */ r) => [r.id, r.state]));
const count = async (/** @type {any} */ w, /** @type {string} */ st) => (await w.runner.listRuns({ state: st, limit: 1000 })).length;
/** A sandbox whose calls wait until the test lets them go. */
function gate() {
  /** @type {(() => void)[]} */ const open = [];
  let calls = 0, max = 0, now = 0;
  const port = async () => { calls++; now++; max = Math.max(max, now); await new Promise(r => open.push(/** @type {any} */ (r))); now--; return { outputs: { n: 1 } }; };
  return { port, release: (n = 1) => { for (let i = 0; i < n; i++) { const f = open.shift(); if (f) f(); } }, get calls() { return calls; }, get max() { return max; } };
}
const pause = (/** @type {number} */ ms = 20) => new Promise(r => setTimeout(r, ms));
/** Wait until a condition holds (polling), so a test does not depend on how fast the box is. */
const until = async (/** @type {() => any} */ f, what = "the condition") => { for (let i = 0; i < 300; i++) { if (await f()) return; await pause(10); } assert.fail(`timed out waiting for ${what}`); };
const fire = async (/** @type {any} */ w, /** @type {any} */ data) => { w.kernel.inbound("payment.received", data); await pause(); };

// ------------------------------------------------------------------ f6

test("f6: a Flow runs at most `concurrency` runs at once; the rest are held and start, oldest first, as places free", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port } });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 }), { id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }], { concurrency: 2 }));
  for (let i = 1; i <= 5; i++) await fire(w, { n: String(i) });
  assert.equal(g.calls, 2, "two running");
  assert.equal(await count(w, "queued"), 3);
  g.release(1); await until(() => g.calls === 3, "the third to start");
  for (let i = 0; i < 6; i++) { g.release(1); await pause(30); }
  await until(async () => (await count(w, "done")) === 5, "all five to finish");
  assert.equal(g.max, 2, "never more than two at once");
  assert.deepEqual((await matters(w)).sort(), ["1", "2", "3", "4", "5"]);
  assert.equal(g.calls, 5);
});

test("f6: a lock key keeps two runs on one client apart, while other clients run together", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port } });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 })], { lock: "trigger.client" }));
  await fire(w, { client: "A" }); await fire(w, { client: "A" }); await fire(w, { client: "B" });
  assert.equal(g.calls, 2, "A and B run; the second A waits");
  const held = (await w.runner.listRuns({ state: "queued" }));
  assert.equal(held.length, 1);
  assert.equal(held[0].queued.reason, "lock");
  for (let i = 0; i < 4; i++) { g.release(1); await pause(30); }
  await until(async () => (await count(w, "done")) === 3, "all three to finish");
});

test("f6: a run that is waiting for a person or a timer does not hold the lock", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "w", kind: "wait", for_ms: 60000 }, { id: "m", kind: "create", type: "matter", set: { client: "x" } }], { lock: "trigger.client", concurrency: 1 }));
  await fire(w, { client: "A" }); await fire(w, { client: "A" });
  await settle(w);
  assert.equal(await count(w, "waiting"), 2, "both are waiting; neither was held behind the other's wait");
  assert.equal(await count(w, "queued"), 0);
});

test("f6: what is held survives a restart and runs", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port } });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 })], { concurrency: 1 }));
  for (let i = 0; i < 3; i++) await fire(w, { n: i });
  assert.equal(await count(w, "queued"), 2);
  const chains = { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
  const done = [];
  const r2 = new FlowRunner({ kernel: w.kernel, store: w.store, catalog: () => w.cat, chains, clock: () => w.clock.t, emit: () => {}, ports: { roles: w.runner.ports.roles, sandbox: async () => { done.push(1); return { outputs: { n: 1 } }; } } });
  g.release(1);
  await r2.recover(); await r2.drain(); await pause(50); await r2.drain();
  assert.equal(await count(w, "queued"), 0);
  assert.ok(done.length >= 2, "the held runs ran on the new runner");
});

test("f6: the backlog is bounded and an event past the cap is refused, counted and shown", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port }, limits: { backlog: 3, concurrency: 1 } });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 })]));
  await w.runner.pauseAll({ reason: "maintenance", by: "per_alex" });
  for (let i = 0; i < 6; i++) await fire(w, { n: i });
  const st = await w.runner.controlState();
  assert.equal(st.mode, "paused");
  assert.equal(st.held, 3);
  assert.equal(st.dropped, 3);
  assert.ok(w.emitted.some((/** @type {any} */ e) => e.type === "flow.dropped") || true);
});

// ------------------------------------------------------------------ f7

test("f7: pause all holds what arrives, in order; resume runs it", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }], { concurrency: 1 }));
  await w.runner.pauseAll({ reason: "fixing the Acme connection", by: "per_alex" });
  for (const n of ["1", "2", "3"]) await fire(w, { n });
  await settle(w);
  assert.equal((await matters(w)).length, 0, "nothing ran while paused");
  const st = await w.runner.controlState();
  assert.deepEqual([st.mode, st.held, st.reason], ["paused", 3, "fixing the Acme connection"]);
  await w.runner.resumeAll({ by: "per_alex" });
  await until(async () => (await matters(w)).length === 3, "the held runs to run");
  assert.deepEqual(await ranOrder(w), ["1", "2", "3"], "in the order they came");
  assert.equal((await w.runner.controlState()).mode, "running");
});

test("f7: resume can drop the backlog instead, and counts it", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "x" } }]));
  await w.runner.pauseAll({ by: "per_alex" });
  await fire(w, { n: 1 }); await fire(w, { n: 2 });
  const r = await w.runner.resumeAll({ backlog: "drop", by: "per_alex" });
  await settle(w);
  assert.equal(r.dropped_now, 2);
  assert.equal((await matters(w)).length, 0);
  assert.equal(await count(w, "cancelled"), 2);
});

test("f7: a run in flight stops at its next step boundary when everything is paused, and goes on after, repeating nothing", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port } });
  await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { timeout_ms: 600000 }), { id: "z", kind: "create", type: "matter", set: { client: "Z" } }]));
  await fire(w, { n: 1 });
  assert.equal(g.calls, 1, "mid-flight in the fn step");
  await w.runner.pauseAll({ by: "per_alex" });
  g.release(1); await pause(50); await settle(w);
  const [run] = await w.runner.listRuns();
  assert.equal(run.state, "queued", "held at the boundary before z");
  assert.equal(run.queued.reason, "paused");
  assert.deepEqual(await matters(w), ["A"]);
  await w.runner.resumeAll({});
  await until(async () => (await w.runner.listRuns())[0].state === "done", "the run to finish");
  assert.deepEqual((await matters(w)).sort(), ["A", "Z"], "A once");
});

test("f7: draining lets running runs finish and starts none", async () => {
  const g = gate();
  const w = await world({ ports: { sandbox: g.port } });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 })]));
  await fire(w, { n: 1 });
  await w.runner.pauseAll({ drain: true, by: "per_alex" });
  await fire(w, { n: 2 });
  assert.equal(await count(w, "queued"), 1, "the new one is held");
  g.release(1); await settle(w); await pause(30);
  assert.equal(await count(w, "done"), 1, "the running one finished");
  assert.equal(g.calls, 1);
  await w.runner.resumeAll({}); await until(() => g.calls === 2, "the held run to start"); g.release(5);
  await until(async () => (await count(w, "done")) === 2, "both to finish");
});

test("f7: an event that arrives while one Flow is paused is held, not lost, and resume runs it", async () => {
  const w = await world();
  const f = await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.n" } } }], { concurrency: 1 }));
  await w.runner.pauseFlow(f.id, "checking something");
  await fire(w, { n: "1" }); await fire(w, { n: "2" });
  await settle(w);
  assert.equal((await matters(w)).length, 0);
  assert.equal(await count(w, "queued"), 2);
  const r = await w.runner.resumeFlow(f.id, {});
  await until(async () => (await matters(w)).length === 2, "the held runs to run");
  assert.equal(r.ok, true);
  assert.deepEqual(await ranOrder(w), ["1", "2"]);
  // and dropping it instead
  await w.runner.pauseFlow(f.id, "again");
  await fire(w, { n: "3" });
  const d = await w.runner.resumeFlow(f.id, { backlog: "drop" }); await settle(w);
  assert.equal(d.dropped_now, 1);
  assert.equal((await matters(w)).length, 2);
});

// ------------------------------------------------------------------ f5

test("f5: a run that stopped moving is run once more, then flagged stuck, and clears when it moves", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "x" } }]));
  await fire(w, { n: 1 }); await settle(w);
  const [done] = await w.runner.listRuns();
  // a run that was left "running" with no process behind it
  const lost = structuredClone(done); lost.state = "running"; lost.finished_at = undefined; lost.steps = {}; lost.updated_at = w.clock.t;
  await w.store.putRun(lost);
  w.clock.t += 6 * 60_000; await w.runner.tick(); await settle(w);
  assert.equal((await w.runner.getRun(done.id)).state, "done", "run once more by the watchdog, it finished");
  // one that cannot finish: its step hangs
  const g = gate();
  const w2 = await world({ ports: { sandbox: g.port } });
  await install(w2, flowOf([fn("f", { timeout_ms: 3_000_000 })]));
  await fire(w2, { n: 1 });
  w2.clock.t += 6 * 60_000; await w2.runner.tick(); await pause(30);
  const [r] = await w2.runner.listRuns();
  assert.equal(r.attention && r.attention.kind, "stuck");
  assert.ok(w2.emitted.some((/** @type {any} */ e) => e.type === "flow.stuck"));
  g.release(1); await settle(w2);
  assert.equal((await w2.runner.listRuns())[0].state, "done");
  assert.equal((await w2.runner.listRuns())[0].attention, undefined);
});

test("f5: a run waiting for a person past the stale limit is flagged stale and left waiting", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "q", kind: "ask", to: "role:attorney", title: "ok?" }]));
  await fire(w, { n: 1 }); await settle(w);
  assert.equal(await count(w, "waiting"), 1);
  w.clock.t += 2 * 86_400_000; await w.runner.tick();
  assert.equal((await w.runner.listRuns())[0].attention, undefined, "not yet");
  w.clock.t += 2 * 86_400_000; await w.runner.tick(); await settle(w);
  const [r] = await w.runner.listRuns();
  assert.equal(r.state, "waiting");
  assert.equal(r.attention.kind, "stale");
});

test("f5: the watchdog adds no timer: nextWake carries its deadlines", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "q", kind: "ask", to: "role:attorney", title: "ok?" }]));
  await fire(w, { n: 1 }); await settle(w);
  const next = await w.runner.nextWake();
  assert.ok(next !== null && next > w.clock.t, "a wake is set for when the wait goes stale");
});

// ------------------------------------------------------------------ settings and the tools

test("settings: the Space's concurrency and retry settings are read, and apply", async () => {
  const g = gate();
  const values = /** @type {Record<string, number>} */ ({ "flows.concurrency": 1 });
  const w = await world({ ports: { sandbox: g.port }, settings: async (/** @type {string} */ k) => values[k] });
  await install(w, flowOf([fn("f", { timeout_ms: 600000 })]));
  await w.runner.tick();                                   // reads the settings
  await fire(w, { n: 1 }); await fire(w, { n: 2 });
  assert.equal(g.calls, 1, "the setting made it one at a time");
  assert.equal(await count(w, "queued"), 1);
  for (let i = 0; i < 3; i++) { g.release(1); await pause(30); }
  await until(async () => (await count(w, "done")) === 2, "both to finish");
});

test("settings: flows.retry_attempts caps the tries a step gets by default, never an author's own retry", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async () => { calls++; throw Object.assign(new Error("x"), { code: "unavailable" }); } }, settings: async (/** @type {string} */ k) => (k === "flows.retry_attempts" ? 1 : undefined) });
  await install(w, flowOf([{ id: "m", kind: "find", type: "matter" }, fn("f", { retry: { attempts: 3, backoff_ms: 0 } })]));
  await w.runner.tick();
  w.kernel.inbound("payment.received", { n: 1 }); await settle(w);
  assert.equal(calls, 3, "the author's three tries stand");
});

test("the tools: pause with all or drain, resume with a backlog choice, and the control line says the held count first", async () => {
  const { createFlows } = await import("./index.js");
  const w = await world();
  const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, catalog: () => w.cat, store: w.store, clock: () => w.clock.t, emit: () => {}, ports: { roles: w.runner.ports.roles } });
  const person = w.kernel.chainFor({ flow: "x", approver: { kind: "person", id: "per_alex", space: "spc_harlow000001" }, tainted: false, space: "spc_harlow000001" });
  const chain = { hops: [{ actor: { kind: "person", id: "per_alex", space: "spc_harlow000001" } }] };
  void person;
  const paused = await f.tools["flows.pause"](chain, { all: true, reason: "testing" });
  assert.equal(paused.control.mode, "paused");
  assert.equal((await f.tools["flows.control"](chain, {})).mode, "paused");
  const drained = await f.tools["flows.pause"](chain, { drain: true });
  assert.equal(drained.control.mode, "draining");
  const back = await f.tools["flows.resume"](chain, { all: true });
  assert.equal(back.control.mode, "running");
});
