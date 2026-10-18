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

test("(c) a retry from before a step that already sent is refused and sends nothing; from after it, or over a send that failed, it works", async () => {
  const sb = sandbox();
  const sent = /** @type {string[]} */ ([]);
  const w = await world({ ports: { sandbox: sb.port, call: async (/** @type {any} */ _c, /** @type {string} */ a) => { sent.push(a); return { ok: true }; } } });
  const { SPACE } = await import("./testing/fixtures.js");
  const f = await install(w, flowOf([fn("a"), { id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } }, fn("c")]));
  const first = await fire(w);
  // the run as it stands once the email went out and the last step then failed
  const stage = async (/** @type {any} */ mail) => { const r = await w.store.getRun(first.id); r.state = "failed"; r.waiting = undefined; r.error = { step: "c", code: "boom", message: "boom" }; r.steps = { a: { status: "done", output: { n: "a" } }, mail, c: { status: "failed", error: { code: "boom" } } }; await w.store.putRun(r); };
  await stage({ status: "done", output: { ok: true }, sent_at: w.clock.t });
  await assert.rejects(() => w.runner.retry(first.id, { from: "a" }), (/** @type {any} */ e) => e.code === "already_sent" && /start a new run to send again/.test(e.message));
  await assert.rejects(() => w.runner.retry(first.id, { from: "mail" }), (/** @type {any} */ e) => e.code === "already_sent");
  assert.deepEqual(sent, [], "nothing was sent");
  sb.calls.length = 0;
  await w.runner.retry(first.id, { from: "c" }); await settle(w);
  assert.deepEqual(sb.calls, ["c"], "from after the send it works, and the send is not touched");
  assert.equal((await w.store.getRun(first.id)).steps.mail.status, "done");
  // a send that failed and is not known to have gone out may be tried again from before it
  await stage({ status: "failed", error: { code: "unavailable" } });
  await assert.doesNotReject(() => w.runner.retry(first.id, { from: "a" }));
  assert.ok(f.id);
});

test("(c) a retry from a step runs the version the run started on, not a newer one, and a draft keeps the same idempotency key", async () => {
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

test("flows.step.test tries one step on a past run's recorded inputs, says what it would send, and sends nothing", async () => {
  const sb = sandbox();
  const sent = /** @type {string[]} */ ([]);
  const w = await world({ ports: { sandbox: sb.port, call: async (/** @type {any} */ _c, /** @type {string} */ a) => { sent.push(a); return { ok: true }; } } });
  const { SPACE } = await import("./testing/fixtures.js");
  const f = await install(w, flowOf([fn("a"), { id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: { expr: "steps.a.n" }, api_key: "secret-token-value-123456" } }]));
  const run = await fire(w);
  const t = toolsOf(w).tools["flows.step.test"];
  const out = await t(chainOf(), { id: f.id, step: "mail", run: run.id });
  assert.equal(out.step, "mail");
  assert.equal(out.input.to, "a", "the earlier step's recorded output is what it reads");
  assert.equal(out.input.api_key, "[hidden]", "redacted as the ledger shows it");
  assert.equal(out.effects.length, 1);
  assert.equal(out.effects[0].outward, true);
  assert.match(out.effects[0].would, /^would send: /);
  assert.deepEqual(sent, [], "nothing was sent");
  assert.deepEqual(sb.calls, ["a"], "and the earlier step was not run again");
  // sample values stand in for the trigger; an unsaved Flow can be tried
  const draft = await t(chainOf(), { flow: flowOf([{ id: "d", kind: "decide", if: "trigger.n > 1", then: [fn("x")], else: [] }]), step: "d", sample: { n: 5 } });
  assert.deepEqual(draft.input, { if: "trigger.n > 1", value: true });
  assert.equal(draft.ok, true);
  // the questions it refuses
  await assert.rejects(() => t(chainOf(), { id: f.id, step: "mail" }), /either run .* or sample/);
  await assert.rejects(() => t(chainOf(), { id: f.id, step: "mail", run: run.id, sample: {} }), /either run .* or sample/);
  await assert.rejects(() => t(chainOf(), { id: f.id, step: "nope", sample: {} }), (/** @type {any} */ e) => e.code === "no_such_step");
  await assert.rejects(() => t(chainOf(), { id: f.id, step: "mail", run: "run_missing" }), (/** @type {any} */ e) => e.code === "not_found");
});

test("the engine half of 'if empty, use': coalesce inside text gives the fallback for a value from the lane that did not run, and the value when there is one", async () => {
  const { parse, evaluate } = await import("./expr.js");
  const expr = parse('"Hello " + text(coalesce(steps.other.output.id, "someone"))');
  assert.equal(evaluate(expr, { steps: {} }), "Hello someone", "the other lane of an If never ran: no value");
  assert.equal(evaluate(expr, { steps: { other: null } }), "Hello someone", "a step that was turned off or skipped gives null");
  assert.equal(evaluate(expr, { steps: { other: { output: { id: null } } } }), "Hello someone");
  assert.equal(evaluate(expr, { steps: { other: { output: { id: "Dana" } } } }), "Hello Dana");
  // the checker lets a Flow read it after the rejoin
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  const f = flowOf([{ id: "d", kind: "decide", if: "trigger.n > 5", then: [fn("big")], else: [] }, fn("after", { inputs: { who: { expr: 'text(coalesce(steps.big.n, "someone"))' } } })]);
  await install(w, f);
  const run = await fire(w, "payment.received", { n: 1 });
  assert.equal(run.state, "done");
  assert.equal(run.steps.after.input.who, "someone");
});

test("(c) a send in the Flow's own failure path, or in a lane of a parallel step, counts: a retry that would clear it is refused, and one after the parallel step is not", async () => {
  const sb = sandbox();
  const sent = /** @type {string[]} */ ([]);
  const w = await world({ ports: { sandbox: sb.port, call: async (/** @type {any} */ _c, /** @type {string} */ a) => { sent.push(a); return { ok: true }; } } });
  const { SPACE } = await import("./testing/fixtures.js");
  const mail = (/** @type {string} */ id) => ({ id, kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } });
  // 1. the failure path
  await install(w, { ...flowOf([fn("a"), fn("c")]), on_failure: [mail("apology")] });
  const first = await fire(w);
  const r1 = await w.store.getRun(first.id);
  r1.state = "failed"; r1.waiting = undefined; r1.error = { step: "c", code: "boom", message: "boom" };
  r1.steps = { a: { status: "done", output: { n: "a" } }, c: { status: "failed", error: { code: "boom" } }, "apology!onfail": { status: "done", output: { ok: true }, sent_at: w.clock.t } };
  await w.store.putRun(r1);
  await assert.rejects(() => w.runner.retry(first.id, { from: "c" }), (/** @type {any} */ e) => e.code === "already_sent", "the apology already went out and the retry would clear it");
  assert.deepEqual(sent, []);
  // 2. a lane of a parallel step: the lane is a run of its own
  w.clock.t += 1000;
  const f2 = await install(w, { ...flowOf([fn("a"), { id: "p", kind: "parallel", steps: [{ id: "l1", kind: "branch", steps: [mail("laneMail")] }] }, fn("c")]), name: "lanes", trigger: { on: "event", event: "lane.go" } });
  w.kernel.inbound("lane.go", { n: 1 }); await settle(w);
  const parent = (await w.runner.listRuns({ flow: f2.id }))[0];
  const p = await w.store.getRun(parent.id);
  const child = (p.steps.p && p.steps.p.children || [])[0] || (p.waiting && p.waiting.children || [])[0];
  assert.ok(child, "the lane has a run of its own: " + JSON.stringify(p.steps).slice(0, 200));
  const c = await w.store.getRun(child);
  c.steps = { laneMail: { status: "done", output: { ok: true }, sent_at: w.clock.t } }; c.state = "done"; await w.store.putRun(c);
  p.state = "failed"; p.waiting = undefined; p.error = { step: "c", code: "boom", message: "boom" };
  p.steps = { a: { status: "done", output: { n: "a" } }, p: { status: "done", output: {}, children: [child] }, c: { status: "failed", error: { code: "boom" } } };
  await w.store.putRun(p);
  await assert.rejects(() => w.runner.retry(p.id, { from: "p" }), (/** @type {any} */ e) => e.code === "already_sent", "from the parallel step, its lane's send would be run again");
  await assert.rejects(() => w.runner.retry(p.id, { from: "a" }), (/** @type {any} */ e) => e.code === "already_sent");
  assert.deepEqual(sent, [], "nothing was sent");
  sb.calls.length = 0;
  await w.runner.retry(p.id, { from: "c" }); await settle(w);
  assert.deepEqual(sb.calls, ["c"], "from after the parallel step it works");
});

test("(c) a lane whose run or version cannot be read counts as having sent: the retry is refused", async () => {
  const sb = sandbox();
  const w = await world({ ports: { sandbox: sb.port } });
  const f = await install(w, flowOf([fn("a"), fn("c")]));
  const run = await fire(w);
  const r = await w.store.getRun(run.id);
  r.state = "failed"; r.waiting = undefined; r.error = { step: "c", code: "boom", message: "boom" };
  r.steps = { a: { status: "done", output: { n: "a" }, children: ["run_that_is_gone"] }, c: { status: "failed", error: { code: "boom" } } };
  await w.store.putRun(r);
  await assert.rejects(() => w.runner.retry(run.id, { from: "a" }), (/** @type {any} */ e) => e.code === "already_sent", "the child run is missing");
  // a child whose version has been removed
  const child = { ...r, id: "run_child_x", flow: f.id, version: 99, state: "done", steps: {} };
  await w.store.putRun(child);
  r.steps.a.children = [child.id]; await w.store.putRun(r);
  await assert.rejects(() => w.runner.retry(run.id, { from: "a" }), (/** @type {any} */ e) => e.code === "already_sent", "the child's version is missing");
});
