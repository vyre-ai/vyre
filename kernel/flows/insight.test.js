// @ts-check
// Flows reliability, wave 3: the health line (f8), the run timeline (f12), version compare and rollback (f11), and flows.describe.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";
import { diffFlows } from "./diff.js";
import { healthOf } from "./health.js";
import { timelineOf } from "./timeline.js";
import { showable } from "./runner.js";
import { sourceHash } from "./schema.js";

const flowOf = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const src = "return { n: 1 };";
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"], ...extra });
const coded = (/** @type {string} */ code) => Object.assign(new Error(`port said ${code}`), { code });
const fire = async (/** @type {any} */ w, data = { n: 1 }) => { w.kernel.inbound("payment.received", data); await settle(w); return (await w.runner.listRuns())[0]; };
const chainOf = () => ({ hops: [{ actor: ALEX }] });
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, catalog: () => w.cat, store: w.store, clock: () => w.clock.t, emit: () => {}, ports: w.runner.ports });

// ------------------------------------------------------------------ f8

test("f8: the health line says last run, this week, what needs a person, and what is held", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  const f = await install(w, flowOf([fn("f", { retry: false })]));
  let h = await w.runner.health(f.id);
  assert.match(h.line, /Never run/);
  assert.equal(h.level, "green");
  await fire(w);
  w.clock.t += 2 * 3_600_000;
  h = await w.runner.health(f.id);
  assert.match(h.line, /Last run 2 hours ago, failed/);
  assert.match(h.line, /0 of 1 ok this week/);
  assert.match(h.line, /1 needs you/);
  assert.equal(h.level, "red", "every run this week failed");
  assert.deepEqual(h.week, { ok: 0, failed: 1, total: 1 });
});

test("f8: a paused Flow, a paused Space and a red Connection are said first", async () => {
  const w = await world();
  const f = await install(w, flowOf([{ id: "s", kind: "service", connector: "practice", method: "GET", path: "/matters/1" }]));
  await w.runner.pauseFlow(f.id, "checking");
  let h = await w.runner.health(f.id);
  assert.match(h.line, /^Paused: checking/);
  await w.runner.resumeFlow(f.id);
  await w.runner.pauseAll({ reason: "maintenance" });
  h = await w.runner.health(f.id);
  assert.match(h.line, /^Everything is paused \(maintenance\)/);
  await w.runner.resumeAll({});
  w.cat.lights = { practice: "red" };
  h = await w.runner.health(f.id);
  assert.match(h.line, /^Red: practice is down/);
  assert.equal(h.level, "red");
  assert.deepEqual(h.red_connections, ["practice"]);
});

test("f8: a Flow on a schedule says when it runs next, in the Space's zone", () => {
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);
  const h = healthOf({ id: "f", label: "Weekly", status: "active", runs: [], now, nextAt: Date.UTC(2026, 9, 5, 9, 0, 0), tz: "UTC" });
  assert.match(h.line, /next Monday 09:00/);
});

test("f8: flows.list carries the line per Flow", async () => {
  const w = await world();
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", set: { client: "x" } }]));
  const rows = await toolsOf(w).tools["flows.list"](chainOf(), {});
  assert.equal(rows.length, 1);
  assert.match(rows[0].line, /Never run/);
  assert.equal(rows[0].label, "Welcome");
});

// ------------------------------------------------------------------ f12

test("f12: the timeline shows tries, the check, a skip with who gave the value, and an approval with who answered", async () => {
  let calls = 0;
  const w = await world({ ports: { sandbox: async (/** @type {any} */ req) => { if (req.source === src && ++calls < 2) throw coded("unavailable"); return { outputs: { n: 1 } }; } } });
  await install(w, flowOf([
    fn("flaky", { retry: { attempts: 3, backoff_ms: 0 }, label: "Fetch the thing" }),
    { id: "m", kind: "create", type: "matter", set: { client: "X" }, verify: { check: "output.record.id != null", say: "saved" } },
  ]));
  const run = await fire(w);
  const lines = timelineOf(run, (await w.store.getVersion(run.flow, run.version)).flow).lines;
  assert.match(lines[0], /^DONE/);
  assert.match(lines[1], /#1 Fetch the thing  ok .*2 tries \(unavailable, ok\)/);
  assert.match(lines[2], /#2 m  ok .*record .*verify ok/);
  const t = await w.runner.timeline(run.id);
  assert.deepEqual(t.lines, lines);
  const d = (await w.runner.timeline(run.id, { step: "m" })).step;
  assert.equal(d.verify.ok, true);
  assert.ok(d.input, "an effect step's input is on the record");
});

test("f12: a skipped step and a failed one read plainly; a failure path is marked", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false, on_fail: { then: "continue", steps: [{ id: "n", kind: "create", type: "matter", set: { client: "handled" } }] } }), fn("g", { retry: false })]));
  const run = await fire(w);
  const lines = timelineOf(run, (await w.store.getVersion(run.flow, run.version)).flow).lines.join("\n");
  assert.match(lines, /FAILED/);
  assert.match(lines, /\(failure path\) n/);
  assert.match(lines, /f  handled/);
  await w.runner.retry(run.id, { skip: true, by: "per_alex" }); await settle(w);
  const again = await w.runner.timeline(run.id);
  assert.match(again.lines.join("\n"), /g  skipped.*no value needed/);
});

test("f12: no secret reaches a timeline: credential shapes and secret-named keys are hidden, and an input is capped", () => {
  const shown = showable({ to: "x@y.z", api_key: "abc", note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", nested: { password: "p", text: "hello" }, ssn: "{{field:ssn}}" });
  const text = JSON.stringify(shown);
  assert.ok(!/sk-ant|abc"|"p"/.test(text), text);
  assert.equal(shown.api_key, "[hidden]");
  assert.equal(shown.ssn, "{{field:ssn}}", "a sealed placeholder stays a placeholder");
  assert.equal(shown.nested.text, "hello");
  const big = showable({ blob: "x".repeat(5000) });
  assert.equal(big.cut, true);
  assert.ok(JSON.stringify(big).length < 2200);
});

// ------------------------------------------------------------------ f11

test("f11: a diff names the steps added, removed, moved and changed, and what changed in them", () => {
  const a = flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "A" } }, { id: "b", kind: "create", type: "matter", set: { client: "B" } }, { id: "c", kind: "create", type: "matter", set: { client: "C" } }]);
  const b = flowOf([{ id: "b", kind: "create", type: "matter", set: { client: "B2" }, retry: false }, { id: "a", kind: "create", type: "matter", set: { client: "A" } }, { id: "d", kind: "create", type: "matter", set: { client: "D" } }], { concurrency: 2, trigger: { on: "event", event: "payment.sent" } });
  const d = diffFlows(a, b);
  assert.equal(d.same, false);
  assert.deepEqual(d.added.map(x => x.id), ["d"]);
  assert.deepEqual(d.removed.map(x => x.id), ["c"]);
  assert.deepEqual(d.moved.map(x => x.id).sort(), ["a", "b"]);
  assert.deepEqual(d.changed.find(x => x.id === "b")?.keys.map(k => k.key).sort(), ["retry", "set"]);
  assert.deepEqual(d.flow.map(x => x.key).sort(), ["concurrency", "trigger"]);
  assert.ok(d.summary.some(s => /adds create step d/.test(s)) && d.summary.some(s => /removes create step c/.test(s)));
  assert.equal(diffFlows(a, a).same, true);
});

test("f11: rollback approves the earlier version again as the person who clicked, and in-flight runs keep their version", async () => {
  const w = await world();
  const f = toolsOf(w);
  const v1 = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "one" } }]));
  const waiting = flowOf([{ id: "w", kind: "wait", for_ms: 600000 }, { id: "a", kind: "create", type: "matter", set: { client: "two" } }]);
  const d2 = await w.runner.define(v1.id, waiting, ALEX);
  await w.runner.approve(d2.id, d2.version, ALEX, d2.hash);
  w.kernel.inbound("payment.received", { n: 1 }); await settle(w);
  const inflight = (await w.runner.listRuns())[0];
  assert.equal(inflight.version, 2);
  const diff = await f.tools["flows.diff"](chainOf(), { id: v1.id, from: 1, to: 2 });
  assert.ok(diff.summary.length >= 2);
  const r = await f.tools["flows.rollback"](chainOf(), { id: v1.id, to: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.active, r.was], [1, 2]);
  assert.ok(r.changes.some((/** @type {string} */ c) => /removes wait step w/.test(c)));
  assert.equal((await w.store.active(v1.id)).version, 1);
  assert.equal((await w.runner.getRun(inflight.id)).version, 2, "the run in flight keeps its version");
  assert.equal((await f.tools["flows.rollback"](chainOf(), { id: v1.id, to: 1 })).note, "that version is already the active one");
  await assert.rejects(() => f.tools["flows.rollback"](chainOf(), { id: v1.id, to: 9 }), (/** @type {any} */ e) => e.code === "not_found");
});

test("f11: rollback with retry_failed moves failed runs that still match to the restored version", async () => {
  let broken = true;
  const w = await world({ ports: { sandbox: async () => { if (broken) throw coded("bad_output"); return { outputs: { n: 1 } }; } } });
  const f = toolsOf(w);
  const v1 = await install(w, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "one" } }, fn("f", { retry: false })]));
  const d2 = await w.runner.define(v1.id, flowOf([{ id: "a", kind: "create", type: "matter", set: { client: "one" } }, fn("f", { retry: false }), { id: "z", kind: "create", type: "matter", set: { client: "Z" } }]), ALEX);
  await w.runner.approve(d2.id, d2.version, ALEX, d2.hash);
  const failed = await fire(w);
  assert.equal(failed.state, "failed");
  broken = false;
  const r = await f.tools["flows.rollback"](chainOf(), { id: v1.id, to: 1, retry_failed: true });
  await settle(w);
  assert.deepEqual(r.retried, [failed.id]);
  assert.equal((await w.runner.getRun(failed.id)).state, "done");
  assert.equal((await w.runner.getRun(failed.id)).version, 1);
});

// ------------------------------------------------------------------ describe

test("flows.describe: a Flow in a few lines with each step's limits and checks, a run with where it is and what next", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  const f = toolsOf(w);
  const v = await install(w, flowOf([fn("f", { timeout_ms: 20000, retry: { attempts: 2, backoff_ms: 0 }, on_fail: { steps: [{ id: "n", kind: "create", type: "matter", set: { client: "x" } }] }, verify: { check: "true", say: "ran" } })], { concurrency: 2 }));
  const flowLines = (await f.tools["flows.describe"](chainOf(), { id: v.id })).lines;
  assert.match(flowLines[0], /^Welcome \(.* v1\), active\. Runs when payment\.received\./);
  assert.ok(flowLines.some((/** @type {string} */ l) => /at most 2 at once/.test(l)));
  assert.ok(flowLines.some((/** @type {string} */ l) => /f: fn .*limit 20 s; 2 tries; if it fails: 1 step, then stop; essential check: ran/.test(l)), flowLines.join("\n"));
  const run = await fire(w);
  const runLines = (await f.tools["flows.describe"](chainOf(), { run: run.id })).lines;
  assert.match(runLines.join("\n"), /FAILED/);
  assert.match(runLines.join("\n"), /Stopped at f: bad_output/);
  assert.match(runLines.join("\n"), /retry from that step, skip it/);
});
