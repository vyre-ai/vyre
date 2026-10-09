// @ts-check
// f3: runs that need a person, and the one answer.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";
import { sourceHash } from "./schema.js";

const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const src = "return { n: 1 };";
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"], ...extra });
const coded = (/** @type {string} */ code, msg = "") => Object.assign(new Error(msg || `port said ${code}`), { code });
const chainOf = () => ({ hops: [{ actor: ALEX }] });
const agentChain = () => ({ hops: [{ actor: ALEX }, { actor: { kind: "agent", id: "juno", space: ALEX.space } }] });
const fire = async (/** @type {any} */ w) => { w.kernel.inbound("payment.received", { n: 1 }); await settle(w); return (await w.runner.listRuns())[0]; };
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn(), runner: undefined });

test("f3: a failed run is one row in plain words, with the Flow and step labels and no secret; a finished run is not", async () => {
  let fails = true;
  const w = await world({ ports: { sandbox: async () => { if (fails) throw coded("bad_output", "the vendor said token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is bad"); return { outputs: { n: 1 } }; } } });
  await install(w, flowOf([fn("f", { retry: false, label: "the letter" })]));
  const run = await fire(w);
  const rows = await w.runner.attention();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].run, rows[0].label, rows[0].step_label, rows[0].kind, rows[0].loud], [run.id, "Welcome", "the letter", "failed", true]);
  assert.doesNotMatch(JSON.stringify(rows), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  fails = false;
  await w.runner.retry(run.id, { by: ALEX.id }); await settle(w);
  assert.deepEqual(await w.runner.attention(), [], "retried and finished: the row is gone");
});

test("f3: flows.settle retries, skips with a value, and stops; a stale wait is quiet", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn() });
  await install(w, flowOf([fn("f", { retry: false }), { id: "m", kind: "create", type: "matter", set: { client: { expr: "steps.f.n" } } }]));
  const run = await fire(w);
  const listed = (await f.tools["flows.attention"](chainOf(), {})).runs;
  assert.equal(listed.length, 1);
  await assert.rejects(() => f.tools["flows.settle"](agentChain(), { run: run.id, action: "retry" }), /only a person/);
  await assert.rejects(() => f.tools["flows.settle"](chainOf(), { run: run.id, action: "nonsense" }), /action is retry, skip, stop or advance/);
  await assert.rejects(() => f.tools["flows.settle"](chainOf(), { action: "retry" }), /run is required/);
  const stopped = await f.tools["flows.settle"](chainOf(), { run: run.id, action: "stop", reason: "not needed" });
  assert.equal(stopped.action, "stop");
  assert.equal((await w.runner.getRun(run.id)).state, "cancelled");
  assert.deepEqual((await f.tools["flows.attention"](chainOf(), {})).runs, [], "a stopped run leaves the list");
  // skip with a value on a fresh failing run
  w.kernel.inbound("payment.received", { n: 2 }); await settle(w);
  const run2 = (await w.runner.listRuns()).find((/** @type {any} */ r) => r.state === "failed");
  const skipped = await f.tools["flows.settle"](chainOf(), { run: run2.id, action: "skip", value: { n: "seven" } });
  assert.equal(skipped.action, "skip");
  await settle(w);
  assert.equal((await w.runner.getRun(run2.id)).state, "done");
});

test("f3: a stale wait is a quiet row, and a stage gate that is stuck shows with its own answer", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "q", kind: "ask", to: "role:attorney", title: "ok?", label: "the yes" }]));
  await fire(w); await settle(w);
  w.clock.t += 4 * 86_400_000; await w.runner.tick(); await settle(w);
  const rows = await w.runner.attention();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].loud], ["stale", false]);
});

test("R031-45: flows.attention also lists the stuck tasks the host reads for it", async () => {
  const w = await world();
  const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn(), stuckTasks: async () => [{ task: "t9", label: "Call the client", reason: "no phone", since: 3 }] });
  const r = await f.tools["flows.attention"](chainOf(), {});
  assert.deepEqual(r.tasks, [{ task: "t9", label: "Call the client", reason: "no phone", since: 3 }]);
  assert.deepEqual(r.runs, []);
});
