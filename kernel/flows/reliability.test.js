// @ts-check
// Flows reliability, wave 1 (f1 timeouts and retry, f2 failure paths and VERIFY, f4 resume / skip / cancel). A runner on the fake world with a hanging, failing or flaky port, and a clock the test moves.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { sourceHash, checkFlow } from "./schema.js";

const mine = (/** @type {any} */ w, /** @type {string} */ type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const src = "return { n: 1 };";
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"], ...extra });
const lastRun = async (/** @type {any} */ w) => (await w.runner.listRuns())[0];
const fire = async (/** @type {any} */ w) => { w.kernel.inbound("payment.received", { n: 1 }); await settle(w); return lastRun(w); };
const hang = () => new Promise(() => {});
const coded = (/** @type {string} */ code) => Object.assign(new Error(`port said ${code}`), { code });

// ------------------------------------------------------------------ f1

test("f1: a step that times out is tried again, with the same key, and the run completes", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async () => (++calls === 1 ? hang() : { outputs: { n: 1 } }) } });
  await install(w, flowOf([fn("f", { timeout_ms: 30, retry: { attempts: 3, backoff_ms: 0 } })]));
  const run = await fire(w);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(calls, 2);
  assert.equal(run.steps.f.tries, 1);
  assert.deepEqual(run.steps.f.attempts_log.map((/** @type {any} */ a) => a.code), ["timeout"]);
});

test("f1: the wait between tries is durable: the run sleeps, and a tick after the wait tries again", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async () => { if (++calls < 3) throw coded("unavailable"); return { outputs: { n: 1 } }; } } });
  await install(w, flowOf([fn("f", { retry: { attempts: 4, backoff_ms: [5000, 10000] } })]));
  let run = await fire(w);
  assert.equal(run.state, "waiting");
  assert.equal(calls, 1);
  w.clock.t += 4000; await w.runner.tick(); await settle(w);
  assert.equal(calls, 1, "not before the wait is over");
  w.clock.t += 1500; await w.runner.tick(); await settle(w);
  assert.equal(calls, 2);
  run = await lastRun(w);
  assert.equal(run.state, "waiting", "second wait is longer");
  w.clock.t += 10_001; await w.runner.tick(); await settle(w);
  run = await lastRun(w);
  assert.equal(run.state, "done");
  assert.equal(calls, 3);
});

test("f1: a refusal is never retried, whatever the policy says", async () => {
  for (const code of ["denied", "outside_caps", "bad_input", "not_found", "taint", "outcome_unknown"]) {
    let calls = 0;
    const w = await world({ ports: { sandbox: async () => { calls++; throw coded(code); } } });
    await install(w, flowOf([fn("f", { retry: { attempts: 5, backoff_ms: 0 } })]));
    const run = await fire(w);
    assert.equal(run.state, "failed", code);
    assert.equal(calls, 1, `${code} was tried once`);
    assert.equal(run.error.code, code);
  }
  const bad = checkFlow(flowOf([fn("f", { retry: { attempts: 2, on: ["denied"] } })]));
  assert.ok(bad.some(p => /retry\.on/.test(p.path)), "a policy cannot name a code from the never list");
});

test("f1: retries run out and the failure is the last one, with every try on the ledger", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async () => { calls++; throw coded("unavailable"); } } });
  await install(w, flowOf([fn("f", { retry: { attempts: 3, backoff_ms: 0 } })]));
  const run = await fire(w);
  assert.equal(run.state, "failed");
  assert.equal(calls, 3);
  assert.equal(run.steps.f.status, "failed");
  assert.equal(run.steps.f.tries, 3);
  assert.equal(run.error.code, "unavailable");
  assert.equal(run.attention.kind, "failed");
});

test("f1: a restart in the middle of the waits repeats nothing and loses nothing", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async () => { if (++calls < 2) throw coded("timeout"); return { outputs: { n: 1 } }; } } });
  await install(w, flowOf([fn("f", { retry: { attempts: 3, backoff_ms: 5000 } })]));
  await fire(w);
  await w.runner.recover();                       // a restart: the waiting run is not "running", nothing re-executes early
  await settle(w);
  assert.equal(calls, 1);
  w.clock.t += 5001; await w.runner.tick(); await settle(w);
  assert.equal(calls, 2);
  assert.equal((await lastRun(w)).state, "done");
});

test("f1: a record write is retried on a flaky kernel with the one idempotency key, so one record is made", async () => {
  const w = await world();
  const real = w.kernel.records.create.bind(w.kernel.records);
  let n = 0;
  const keys = /** @type {any[]} */ ([]);
  w.kernel.records.create = async (c, t, d, o) => { keys.push(o && o.idem); if (++n === 1) throw coded("unavailable"); return real(c, t, d, o); };
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, retry: { attempts: 3, backoff_ms: 0 } }]));
  const run = await fire(w);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(mine(w, "matter").length, 1);
  assert.equal(new Set(keys).size, 1, "the same key on both tries");
});

// ------------------------------------------------------------------ f2

test("f2: a failure path with then: continue handles the failure and the run goes on", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([
    fn("f", { retry: false, on_fail: { then: "continue", steps: [{ id: "n", kind: "create", type: "matter", set: { client: { expr: "error.code" } } }] } }),
    { id: "after", kind: "create", type: "matter", set: { client: "after" } },
  ]));
  const run = await fire(w);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps.f.status, "failed_handled");
  assert.deepEqual(run.steps.f.output, { failed: true, error: { code: "bad_output", message: "port said bad_output" } });
  assert.deepEqual(mine(w, "matter").map((/** @type {any} */ m) => m.data.client).sort(), ["after", "bad_output"]);
});

test("f2: a failure path with then: stop runs, and then the run fails with the original error", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false, on_fail: { steps: [{ id: "n", kind: "create", type: "matter", set: { client: "handled" } }] } }), { id: "after", kind: "create", type: "matter", set: { client: "after" } }]));
  const run = await fire(w);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "bad_output");
  assert.deepEqual(mine(w, "matter").map((/** @type {any} */ m) => m.data.client), ["handled"], "the step after did not run");
});

test("f2: a failure path survives a restart without doing its work twice", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  const { id } = await install(w, flowOf([fn("f", { retry: false, on_fail: { steps: [{ id: "n", kind: "create", type: "matter", set: { client: "handled" } }] } })]));
  const run = await fire(w);
  const again = structuredClone(run); again.state = "running"; again.finished_at = undefined; again.attention = undefined;
  await w.store.putRun(again);
  await w.runner.recover(); await settle(w);
  assert.equal(mine(w, "matter").length, 1, "the handler's record was made once");
  assert.equal((await lastRun(w)).state, "failed");
  assert.ok(id);
});

test("f2: the Flow's own on_failure runs once before the run is called failed", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false })], { on_failure: [{ id: "tell", kind: "create", type: "matter", set: { client: { expr: "error.step" } } }] }));
  const run = await fire(w);
  assert.equal(run.state, "failed");
  assert.deepEqual(mine(w, "matter").map((/** @type {any} */ m) => m.data.client), ["f"]);
  assert.equal(run.error.code, "bad_output");
});

test("f2: a failure path cannot have a failure path of its own", () => {
  const bad = checkFlow(flowOf([fn("f", { on_fail: { steps: [fn("g", { on_fail: { steps: [fn("h")] } })] } })]));
  assert.ok(bad.some(p => /failure path cannot have/.test(p.message)), JSON.stringify(bad));
});

test("f2: an essential verify fails a step whose action succeeded; an optional one only flags", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, verify: { check: "output.record.data.client == 'Y'", say: "the client name did not save" } }]));
  let run = await fire(w);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "verify_failed");
  assert.equal(run.error.message, "the client name did not save");
  assert.equal(run.steps.m.verify.ok, false);
  const w2 = await world();
  await install(w2, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, verify: { check: "output.record.data.client == 'Y'", essential: false, say: "worth a look" } }, { id: "n", kind: "create", type: "matter", set: { client: "next" } }]));
  run = await fire(w2);
  assert.equal(run.state, "done");
  assert.equal(run.steps.m.verify.ok, false);
  assert.equal(run.attention.kind, "verify");
  assert.equal(mine(w2, "matter").length, 2, "the run went on");
});

test("f2: verify readback re-reads the record and compares what was set", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X", plan: "Will" }, verify: { readback: true } }]));
  const run = await fire(w);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps.m.verify.ok, true);
  assert.ok(checkFlow(flowOf([fn("f", { verify: { readback: true } })])).some(p => /readback reads a record/.test(p.message)), "readback belongs on a write");
});

test("f2: a failed verify is not retried (the step did what it did)", async () => {
  const w = await world();
  let creates = 0;
  const real = w.kernel.records.create.bind(w.kernel.records);
  w.kernel.records.create = async (...a) => { creates++; return real(...a); };
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, retry: { attempts: 4, backoff_ms: 0 }, verify: { check: "false" } }]));
  const run = await fire(w);
  assert.equal(run.state, "failed");
  assert.equal(creates, 1);
});

test("f2: a model-written Flow is told which effect steps check nothing", async () => {
  const w = await world();
  const d = await w.runner.define(null, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" } }], { authorship: "model" }), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  assert.ok(d.warnings.some((/** @type {any} */ x) => /checks nothing/.test(x.message)), JSON.stringify(d.warnings));
});

// ------------------------------------------------------------------ f4

test("f4: after a fix, retry resumes at the failed step and nothing earlier runs again", async () => {
  let broken = true, calls = 0;
  const w = await world({ ports: { sandbox: async () => { calls++; if (broken) throw coded("bad_output"); return { outputs: { n: 1 } }; } } });
  await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { retry: false }), { id: "z", kind: "create", type: "matter", set: { client: "Z" } }]));
  let run = await fire(w);
  assert.equal(run.state, "failed");
  assert.equal(run.steps.f.status, "failed");
  broken = false;
  await w.runner.retry(run.id); await settle(w);
  run = await lastRun(w);
  assert.equal(run.state, "done");
  assert.deepEqual(mine(w, "matter").map((/** @type {any} */ m) => m.data.client).sort(), ["A", "Z"], "A was made once");
  assert.equal(run.attention, undefined);
});

test("f4: skip is refused when a later step reads the output, allowed with a substitute value, and the timeline says who supplied it", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false }), { id: "z", kind: "create", type: "matter", set: { client: { expr: "steps.f.n" } } }]));
  const run = await fire(w);
  await assert.rejects(() => w.runner.retry(run.id, { skip: true }), (/** @type {any} */ e) => e.code === "skip_needs_value" && /\bf\b/.test(e.message));
  await w.runner.retry(run.id, { skip: true, value: { n: "supplied" }, by: "per_alex" }); await settle(w);
  const done = await lastRun(w);
  assert.equal(done.state, "done");
  assert.equal(done.steps.f.status, "skipped");
  assert.equal(done.steps.f.substitute, true);
  assert.equal(done.steps.f.skipped_by, "per_alex");
  assert.deepEqual(mine(w, "matter").map((/** @type {any} */ m) => m.data.client), ["supplied"]);
});

test("f4: skip needs no value when nothing reads the step", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false }), { id: "z", kind: "create", type: "matter", set: { client: "Z" } }]));
  const run = await fire(w);
  await w.runner.retry(run.id, { skip: true }); await settle(w);
  const done = await lastRun(w);
  assert.equal(done.state, "done");
  assert.equal(done.steps.f.output, null);
  assert.equal(done.steps.f.substitute, undefined);
});

test("f4: retry on the latest version works when the done steps still match, and is refused when they do not", async () => {
  let broken = true;
  const w = await world({ ports: { sandbox: async () => { if (broken) throw coded("bad_output"); return { outputs: { n: 1 } }; } } });
  const v1 = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { retry: false })]));
  const run = await fire(w);
  // v2: same first step, the failing step fixed by a tail added
  const d2 = await w.runner.define(v1.id, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { retry: false }), { id: "z", kind: "create", type: "matter", set: { client: "Z" } }]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  await w.runner.approve(d2.id, d2.version, { kind: "person", id: "per_alex", space: "spc_harlow000001" }, d2.hash);
  broken = false;
  await w.runner.retry(run.id, { version: "latest" }); await settle(w);
  const done = await lastRun(w);
  assert.equal(done.state, "done");
  assert.equal(done.version, d2.version);
  assert.equal(mine(w, "matter").length, 2);
  // v3 renames the first step: a run that already did it cannot move
  const w2 = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  const a = await install(w2, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { retry: false })]));
  const run2 = await fire(w2);
  const d3 = await w2.runner.define(a.id, flowOf([{ id: "first", kind: "create", type: "matter", set: { client: "A" } }, fn("f", { retry: false })]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  await w2.runner.approve(d3.id, d3.version, { kind: "person", id: "per_alex", space: "spc_harlow000001" }, d3.hash);
  await assert.rejects(() => w2.runner.retry(run2.id, { version: "latest" }), (/** @type {any} */ e) => e.code === "version_mismatch" && /step a/.test(e.message));
});

test("f4: cancel stops a failed or waiting run and keeps its record; a finished run is left alone", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false })]));
  const run = await fire(w);
  const r = await w.runner.cancel(run.id, { by: "per_alex", reason: "not needed" });
  assert.equal(r.ok, true);
  const c = await w.runner.getRun(run.id);
  assert.equal(c.state, "cancelled");
  assert.equal(c.cancelled.by, "per_alex");
  assert.ok(w.emitted.some((/** @type {any} */ e) => e.type === "flow.cancelled"));
  assert.equal((await w.runner.cancel(run.id)).ok, false, "already over");
});

// ------------------------------------------------------------------ the language

import { printFlow, parseFlowText } from "./text.js";

test("the text form round-trips retry, on_fail, verify and the Flow-level keys", () => {
  const flow = { format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, concurrency: 3, lock: "trigger.client", stuck_after_ms: 600000,
    steps: [
      { id: "m", kind: "create", type: "matter", set: { client: "X" }, timeout_ms: 20000, retry: { attempts: 3, backoff_ms: [1000, 2000], on: ["timeout", "unavailable"] }, verify: { check: "output.record.id != null", essential: false, say: "saved" },
        on_fail: { then: "continue", steps: [{ id: "n", kind: "create", type: "matter", set: { client: { expr: "error.code" } } }] } },
    ],
    on_failure: [{ id: "tell", kind: "create", type: "matter", set: { client: "failed" } }] };
  const text = printFlow(flow);
  const back = parseFlowText(text);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.flows[0].flow, flow);
  assert.equal(printFlow(back.flows[0].flow), text, "idempotent");
});

test("a failure path's steps count for the Flow's powers and names", async () => {
  const w = await world();
  const d = await w.runner.define(null, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, on_fail: { steps: [{ id: "r", kind: "remove", type: "matter", record: { expr: "error.step" } }] } }]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  assert.ok(d.caps.some((/** @type {any} */ c) => c.action === "records.remove"), "the handler's remove is among the declared powers");
  const bad = await w.runner.define(null, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "X" }, on_fail: { steps: [{ id: "r", kind: "create", type: "matter", set: { client: { expr: "nothing.here" } } }] } }]), { kind: "person", id: "per_alex", space: "spc_harlow000001" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((/** @type {any} */ e) => /nothing/.test(e.message)), "names in a handler are checked");
});

test("a block takes no policy yet: the schema refuses a key the runner would ignore", () => {
  const bad = checkFlow(flowOf([{ id: "d", kind: "decide", if: "true", then: [], verify: { check: "true" } }]));
  assert.ok(bad.some(p => /verify is not part of this/.test(p.message)), JSON.stringify(bad));
});
