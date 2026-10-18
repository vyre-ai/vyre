// @ts-check
// The Flows editor's backend (0.6.2): several triggers, a step turned off, retry from a chosen step, every step's input in the ledger, and server-side run filters.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";
import { sourceHash, checkFlow } from "./schema.js";
import { printFlow, parseFlowText } from "./text.js";
import { hideRun } from "./redact.js";

const sourceOf = (/** @type {string} */ id) => `return { n: "${id}" };`;
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: sourceOf(id), hash: sourceHash(sourceOf(id)), inputs: {}, outputs: ["n"], ...extra });
const trig = { on: "event", event: "payment.received" };
const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: trig, steps, ...extra });
/** A sandbox that counts how often each step's source ran, and fails a step on demand. */
const sandbox = () => { const calls = /** @type {string[]} */ ([]); const fail = new Set(); return { calls, fail, port: async (/** @type {any} */ req) => { const id = /"(\w+)"/.exec(req.source)?.[1] || "?"; calls.push(id); if (fail.has(id)) throw Object.assign(new Error("boom"), { code: "bad_output" }); return { outputs: { n: id }, ...(req.inputs ? { seen: req.inputs } : {}) }; } }; };
const fire = async (/** @type {any} */ w, type = "payment.received", data = { n: 1 }) => { w.clock.t += 1000; w.kernel.inbound(type, data); await settle(w); return (await w.runner.listRuns())[0]; };
const chainOf = () => ({ hops: [{ actor: ALEX }] });
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, catalog: () => w.cat, store: w.store, clock: () => w.clock.t, emit: () => {}, ports: w.runner.ports });

test("(a) a Flow may have several triggers, each with its own condition; any of them starts a run and the run says which", async () => {
  const w = await world();
  await install(w, { ...flowOf([fn("a")]), trigger: undefined, triggers: [{ ...trig, where: "trigger.n > 5" }, { on: "event", event: "invoice.sent" }] });
  await fire(w, "payment.received", { n: 1 });
  assert.equal((await w.runner.listRuns()).length, 0, "the first trigger's condition does not hold");
  const big = await fire(w, "payment.received", { n: 10 });
  assert.equal(big.trigger.index, 0);
  const other = await fire(w, "invoice.sent", { n: 1 });
  assert.equal(other.trigger.index, 1);
  assert.equal((await w.runner.listRuns()).length, 2);
});

test("(a) the checks: exactly one of trigger and triggers, one to eight of them, each checked on its own path; old single-trigger Flows still pass", () => {
  const base = flowOf([fn("a")]);
  assert.deepEqual(checkFlow(base), [], "the old form loads");
  assert.deepEqual(checkFlow({ ...base, trigger: undefined, triggers: [trig] }), []);
  assert.match(checkFlow({ ...base, triggers: [trig] })[0].message, /either trigger or triggers/);
  const none = { ...base }; delete none.trigger;
  assert.match(checkFlow(none)[0].message, /trigger/);
  assert.match(checkFlow({ ...none, triggers: [] })[0].message, /1 to 8/);
  assert.match(checkFlow({ ...none, triggers: Array.from({ length: 9 }, () => trig) })[0].message, /1 to 8/);
  const bad = checkFlow({ ...none, triggers: [trig, { on: "event", event: "NOT AN EVENT" }] });
  assert.ok(bad.some((p) => p.path === "triggers[1].event"), JSON.stringify(bad));
});

test("(a) the text form carries the list and reads it back the same", () => {
  const f = { ...flowOf([fn("a")]), trigger: undefined, triggers: [{ ...trig, where: "trigger.n > 5" }, { on: "event", event: "invoice.sent" }] };
  delete f.trigger;
  const text = printFlow(f);
  assert.match(text, /triggers:/);
  const back = parseFlowText(text);
  assert.deepEqual(back.flows[0].flow.triggers, f.triggers);
});

test("(b) a step with enabled false is skipped and recorded as off; what reads it gets nothing; a block that is off skips what is inside", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([fn("a"), fn("b", { enabled: false }), { id: "d", kind: "decide", if: "trigger.n > 0", enabled: false, then: [fn("inner")], else: [] }, fn("c")]));
  const run = await fire(w);
  assert.equal(run.state, "done");
  assert.deepEqual(sb.calls, ["a", "c"], "b and the whole decide did not run");
  assert.equal(run.steps.b.status, "skipped");
  assert.equal(run.steps.b.off, true);
  assert.equal(run.steps.b.output, null);
  assert.equal(run.steps.d.off, true);
  assert.equal(run.steps.inner, undefined);
  assert.deepEqual(checkFlow(flowOf([fn("a", { enabled: "no" })])).map((p) => p.path), ["steps[0].enabled"]);
  assert.deepEqual(checkFlow(flowOf([fn("a", { enabled: true })])), []);
});

test("(c) retry from a step runs that step and every step after it again, and keeps what came before", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([fn("a"), fn("b", { retry: false }), fn("c")]));
  sb.fail.add("b");
  const failed = await fire(w);
  assert.equal(failed.state, "failed");
  assert.deepEqual(sb.calls, ["a", "b"]);
  sb.fail.clear(); sb.calls.length = 0;
  await w.runner.retry(failed.id, { from: "a" }); await settle(w);
  assert.deepEqual(sb.calls, ["a", "b", "c"], "from the first step, all of them again");
  assert.equal((await w.store.getRun(failed.id)).state, "done");
  sb.calls.length = 0;
  await w.runner.retry(failed.id, { from: "b" }); await settle(w);
  assert.deepEqual(sb.calls, ["b", "c"], "a finished run goes again from b: a keeps its recorded output");
  assert.equal((await w.store.getRun(failed.id)).state, "done");
});

test("(c) retry from a step that is not in the run's version, or on a run that is still going, is refused in words", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([fn("a"), fn("b")]));
  const run = await fire(w);
  await assert.rejects(() => w.runner.retry(run.id, { from: "nope" }), (/** @type {any} */ e) => e.code === "no_such_step" && /nope/.test(e.message));
});

test("(d) every step's input is in the ledger, hidden where it is secret and never a sealed value", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([fn("a", { inputs: { who: { expr: "trigger.who" }, api_key: { expr: "trigger.key" }, note: { expr: "trigger.note" } } })]));
  const run = await fire(w, "payment.received", { n: 1, who: "Dana", key: "sk-live-abcdefghijklmnop", note: { sealed: true, ref: "r1", value: "SECRET-VALUE" } });
  const input = run.steps.a.input;
  assert.equal(input.who, "Dana");
  assert.equal(input.api_key, "[hidden]");
  assert.deepEqual(input.note, { sealed: true });
  assert.ok(!JSON.stringify(run.steps).includes("SECRET-VALUE"), "a sealed value is never stored in the steps");
  assert.ok(!JSON.stringify(run.steps).includes("sk-live-abcdefghijklmnop"), "a secret is never stored in the steps");
});

test("(d) a decide records the value it tested, and the cap is 16 KB (over it the entry says it was cut)", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([{ id: "d", kind: "decide", if: "trigger.n > 0", then: [fn("x")], else: [] }, fn("big", { inputs: { text: { expr: "trigger.text" } } })]));
  const run = await fire(w, "payment.received", { n: 3, text: "x".repeat(20_000) });
  assert.deepEqual(run.steps.d.input, { if: "trigger.n > 0", value: true });
  assert.equal(run.steps.big.input.cut, true);
  assert.ok(JSON.stringify(run.steps.big.input).length < 17_000);
  const mid = await fire(w, "payment.received", { n: 3, text: "y".repeat(5_000) });
  assert.equal(mid.steps.big.input.text.length > 1000, true, "5 KB is kept whole now");
});

test("(g) flows.runs filters on the server: state, a search word, and a window of start times", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  const f = await install(w, flowOf([fn("a", { retry: false })]));
  await fire(w, "payment.received", { n: 1 }); w.clock.t += 3_600_000;
  sb.fail.add("a");
  const bad = await fire(w, "payment.received", { n: 2 }); w.clock.t += 3_600_000;
  sb.fail.clear();
  await fire(w, "payment.received", { n: 3 });
  const t = toolsOf(w).tools["flows.runs"];
  assert.equal((await t(chainOf(), { id: f.id })).length, 3);
  assert.deepEqual((await t(chainOf(), { id: f.id, state: "failed" })).map((r) => r.id), [bad.id]);
  assert.deepEqual((await t(chainOf(), { id: f.id, q: "boom" })).map((r) => r.id), [bad.id], "the error words are searched");
  assert.equal((await t(chainOf(), { id: f.id, q: "welcome" })).length, 3, "the Flow's label is searched");
  assert.equal((await t(chainOf(), { id: f.id, q: "no such thing" })).length, 0);
  assert.deepEqual((await t(chainOf(), { id: f.id, since: bad.started_at, until: bad.started_at })).map((r) => r.id), [bad.id], "a window");
  assert.equal((await t(chainOf(), { id: f.id, before: bad.started_at })).length, 1, "paged back from a start time");
  assert.equal((await t(chainOf(), { id: f.id, limit: 1 })).length, 1);
  await assert.rejects(() => t(chainOf(), { id: f.id, since: "yesterday" }), /since is a time/);
});

test("(d) a viewer who may not see a step's output may not see its input either, and the starter and author see both", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  await install(w, flowOf([fn("a", { inputs: { who: { expr: "trigger.who" } } })]));
  const run = await fire(w, "payment.received", { n: 1, who: "Dana" });
  assert.equal(run.steps.a.input.who, "Dana", "shown whole to the person it ran as");
  const hidden = hideRun(run, "per_alex");
  assert.equal(hidden.steps.a.input, undefined);
  assert.equal(hidden.steps.a.output, undefined);
  assert.ok(hidden.steps.a.output_hidden);
  assert.ok(!JSON.stringify(hidden).includes("Dana"), "nothing of what it was given is left");
  const viaTool = await toolsOf(w).tools["flows.timeline"](chainOf(), { run: run.id, hide_for: "per_alex", step: "a" });
  assert.ok(!JSON.stringify(viaTool).includes("Dana"), "the timeline's step detail hides it too");
});

test("(c) a retry from a step runs the version the run started on, not a newer one, and an outward act keeps the same idempotency key", async () => {
  const sb = sandbox();
  const idems = /** @type {string[]} */ ([]);
  const w = await world({ ports: { sandbox: sb.port, call: async (/** @type {any} */ _c, /** @type {string} */ _a, /** @type {string} */ _r, /** @type {any} */ _i, /** @type {any} */ o) => { idems.push(o.idem); return { ok: true }; } } });
  const d1 = await install(w, flowOf([{ id: "draft", kind: "call", action: "email.draft", resource: `vyre://${(await import("./testing/fixtures.js")).SPACE}/mail/*`, input: { to: "a@example.com" } }, fn("a")]));
  const run = await fire(w);
  assert.equal(run.state, "done");
  assert.equal(idems.length, 1);
  // a newer version goes live whose code step is different
  const v2 = await w.runner.define(d1.id, flowOf([{ id: "draft", kind: "call", action: "email.draft", resource: `vyre://${(await import("./testing/fixtures.js")).SPACE}/mail/*`, input: { to: "changed@example.com" } }, fn("z")]), ALEX);
  assert.ok(v2.ok, JSON.stringify(v2.errors));
  await w.runner.approve(d1.id, v2.version, ALEX, v2.hash);
  sb.calls.length = 0;
  await w.runner.retry(run.id, { from: "draft" }); await settle(w);
  assert.deepEqual(sb.calls, ["a"], "version 1's code ran, not version 2's");
  assert.equal(idems.length, 2);
  assert.equal(idems[0], idems[1], "the same key, so the receiving side can see it is the same act");
});
