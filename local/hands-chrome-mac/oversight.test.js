// @ts-check
// Oversight, the state machine behind the panel: plan first, interject once, stop at once and
// only once, resume only from a stop, and how long a stop takes to reach the extension.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOversight } from "./oversight.js";

const rig = (/** @type {any} */ o = {}) => {
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const pushed = [];
  const os = createOversight({ emit: (type, p) => events.push({ type, ...p }), push: f => { pushed.push(f); return o.delay ? new Promise(r => setTimeout(r, o.delay)) : true; }, ...o.deps });
  const on = (/** @type {string} */ type) => events.filter(e => e.type === type);
  return { os, events, pushed, on };
};
const AGENT = "mcp:agent:kit";
const STEPS = [{ id: "1", text: "Open the intake page", risk: "low" }, { id: "2", text: "Fill in the form" }];

test("plan first: an agent with no plan is refused, a person's own call is not", () => {
  const { os } = rig();
  assert.throws(() => os.guard("kit", AGENT), { code: "plan_first" });
  assert.doesNotThrow(() => os.guard(null, "cli"));
  assert.doesNotThrow(() => os.guard("kit", "cli"), "an agent's name on a person's direct call is still the person");
});

test("plan: recorded, emitted with the steps, and it lets that agent act", () => {
  const { os, on } = rig();
  assert.equal(os.state, "idle");
  os.plan("kit", STEPS, { thread: "t1" });
  assert.equal(os.state, "planning");
  const [e] = on("chrome.plan");
  assert.deepEqual([e.agent, e.thread, e.steps.length], ["kit", "t1", 2]);
  assert.deepEqual(e.steps[0], { id: "1", text: "Open the intake page", risk: "low", state: "todo" });
  assert.equal(e.run, "t1", "every event carries the run (the thread)");
  assert.equal(e.title, "Open the intake page", "a plan with no title takes its first step");
  os.guard("kit", AGENT);
  assert.equal(os.state, "running");
  assert.throws(() => os.guard("juno", "mcp:agent:juno"), { code: "plan_first" }, "another agent needs its own plan");
});

test("plan: bad plans are refused", () => {
  const { os } = rig();
  assert.throws(() => os.plan("kit", []), { code: "bad_request" });
  assert.throws(() => os.plan("kit", [{ id: "1", text: "a" }, { id: "1", text: "b" }]), { code: "bad_request" });
  assert.throws(() => os.plan("kit", [{ id: "1", text: "  " }]), { code: "bad_request" });
});

test("steps: started, done and failed emit chrome.step and update the snapshot", () => {
  const { os, on } = rig();
  os.plan("kit", STEPS);
  os.stepStarted("1"); os.stepDone("1"); os.stepStarted("2"); os.stepFailed("2", "the form has a captcha");
  assert.deepEqual(on("chrome.step").map(e => [e.id, e.status]), [["1", "running"], ["1", "done"], ["2", "running"], ["2", "failed"]]);
  assert.equal(on("chrome.step")[3].why, "the form has a captcha");
  assert.deepEqual(os.snapshot().steps.map(s => s.status), ["done", "failed"]);
  assert.throws(() => os.stepDone("9"), { code: "bad_request" });
});

test("interject: the next call gets it once, and it is emitted", () => {
  const { os, on } = rig();
  os.plan("kit", STEPS);
  os.interject({ from: "voice", text: "use the second address" });
  assert.deepEqual([on("chrome.interjected")[0].from, on("chrome.interjected")[0].text], ["voice", "use the second address"]);
  assert.deepEqual(os.guard("kit", AGENT), { interjection: "use the second address" });
  assert.deepEqual(os.guard("kit", AGENT), {}, "delivered once");
  os.interject({ from: "prompt", text: "one" }); os.interject({ from: "prompt", text: "two" });
  assert.equal(os.guard("kit", AGENT).interjection, "one\ntwo");
  assert.throws(() => os.interject({ text: " " }), { code: "bad_request" });
});

test("stop: sets stopped, refuses the very next op, tells the extension, and is idempotent", async () => {
  const { os, on, pushed } = rig();
  os.plan("kit", STEPS);
  os.guard("kit", AGENT);
  const p = os.stop({ by: "esc" });
  assert.equal(os.state, "stopped", "set before anything is awaited");
  assert.throws(() => os.guard("kit", AGENT), { code: "stopped" });
  assert.throws(() => os.guard(null, "cli"), { code: "stopped" }, "a person's own call is refused too until they resume");
  const first = await p;
  assert.equal(first.already, false);
  const second = await os.stop({ by: "esc" });
  assert.equal(second.already, true);
  assert.equal(on("chrome.stopped").length, 1, "Esc twice is one stop");
  assert.deepEqual(pushed, [{ event: "stop", by: "esc" }]);
  assert.equal(os.snapshot().stoppedBy, "esc");
});

test("resume: only from stopped or waiting_input, emits, tells the extension, hands the answer to the agent", async () => {
  const { os, on, pushed } = rig();
  os.plan("kit", STEPS);
  await assert.rejects(async () => os.resume({}), { code: "not_stopped" });
  await os.stop({ by: "user" });
  const r = await os.resume({ answer: "yes, go on with the second address" });
  assert.equal(r.state, "running");
  assert.equal(on("chrome.resumed").length, 1);
  assert.deepEqual(pushed.map(p => p.event), ["stop", "resume"]);
  assert.equal(os.guard("kit", AGENT).interjection, "yes, go on with the second address");
  assert.throws(() => os.resume({}), { code: "not_stopped" }, "a second resume has nothing to resume");
  os.waitInput("Which address?");
  assert.equal(os.state, "waiting_input");
  assert.throws(() => os.guard("kit", AGENT), { code: "waiting_input" });
  await os.resume({ answer: "the second" });
  assert.equal(os.state, "running");
});

test("finish: a new run must post its own plan", () => {
  const { os } = rig();
  os.plan("kit", STEPS); os.guard("kit", AGENT);
  os.finish("kit");
  assert.equal(os.state, "idle");
  assert.throws(() => os.guard("kit", AGENT), { code: "plan_first" });
});

test("stopLatencyMs: 20 stops through a fake bridge that takes a few ms are each measured", async () => {
  let t = 0;
  const { os } = rig({ delay: 3, deps: { now: () => performance.now() } });
  void t;
  assert.equal(os.stopLatencyMs, null);
  os.plan("kit", STEPS);
  for (let i = 0; i < 20; i++) {
    const r = await os.stop({ by: "esc" });
    assert.ok(r.latencyMs >= 0 && r.latencyMs < 250, `stop ${i}: ${r.latencyMs}`);
    await os.resume({});
  }
  const ls = os.stopLatencies();
  assert.equal(ls.length, 20);
  assert.equal(os.stopLatencyMs, ls[19]);
  assert.ok(ls.every(x => x >= 2), "the push delay is in the measurement");
});

test("words an agent wrote go through the cleaner before they are published", () => {
  const { os, on } = rig({ deps: { clean: (/** @type {string} */ s) => s.replace(/https?:\/\/\S+/g, "[url]") } });
  os.plan("kit", [{ id: "1", text: "Open https://harlow.example/x?token=abc" }]);
  assert.equal(on("chrome.plan")[0].steps[0].text, "Open [url]");
});

test("panel contract: step state vocabulary, plan title, run on every event", () => {
  const { os, events, on } = rig();
  os.plan("kit", STEPS, { thread: "t9", title: "Fill in the intake form" });
  assert.equal(on("chrome.plan")[0].title, "Fill in the intake form");
  os.stepStarted("1"); os.stepDone("1"); os.stepStarted("2"); os.stepFailed("2", "captcha");
  assert.deepEqual(on("chrome.step").map(e => e.state), ["current", "done", "current", "failed"]);
  assert.ok(events.every(e => e.run === "t9"), "run is on every event: " + JSON.stringify(events.map(e => [e.type, e.run])));
  assert.deepEqual(os.snapshot().steps.map(s => s.state), ["done", "failed"]);
});

test("plan.edit: only a step that has not started can be retexted, and the plan is sent again", () => {
  const { os, on } = rig();
  os.plan("kit", STEPS, { thread: "t1" });
  os.stepStarted("1");
  assert.throws(() => os.editStep({ run: "t1", step: "1", text: "x" }), { code: "bad_request" }, "a running step is steered, not edited");
  assert.deepEqual(os.editStep({ run: "t1", step: "2", text: "Fill in only the name" }), { ok: true, step: "2" });
  assert.equal(on("chrome.plan").at(-1).steps[1].text, "Fill in only the name");
  assert.throws(() => os.editStep({ run: "nope", step: "2", text: "x" }), { code: "not_found" });
  assert.throws(() => os.editStep({ run: "t1", step: "9", text: "x" }), { code: "bad_request" });
});

test("pause: holds like a stop until the person resumes, and says chrome.paused", async () => {
  const { os, on, pushed } = rig();
  os.plan("kit", STEPS, { thread: "t1" });
  os.guard("kit", AGENT);
  const r = await os.pause({ run: "t1" });
  assert.equal(r.paused, true);
  assert.equal(on("chrome.paused").length, 1);
  assert.deepEqual(pushed.at(-1), { event: "stop", by: "user" });
  assert.throws(() => os.guard("kit", AGENT), { code: "stopped" });
  await os.resume({});
  assert.doesNotThrow(() => os.guard("kit", AGENT));
  await assert.rejects(async () => os.pause({ run: "nope" }), { code: "not_found" });
});

test("voice: a live phrase is shown, and only a final phrase reaches the agent, once", () => {
  const { os, on } = rig();
  os.plan("kit", STEPS, { thread: "t1" });
  os.voice({ run: "t1", text: "skip the", final: false });
  assert.equal(on("chrome.interjected").length, 0);
  os.voice({ run: "t1", text: "skip the phone number", final: true });
  assert.deepEqual(on("chrome.voice").map(e => [e.text, e.final]), [["skip the", false], ["skip the phone number", true]]);
  assert.equal(os.guard("kit", AGENT).interjection, "skip the phone number");
  assert.equal(os.guard("kit", AGENT).interjection, undefined, "once");
});

test("oversight: a finished run emits chrome.finished {agent, run, ok}; a stop emits it with ok false; a run that was never planned emits nothing on stop", () => {
  /** @type {any[]} */ const got = [];
  const o = createOversight({ emit: (/** @type {string} */ type, /** @type {any} */ p) => got.push({ type, ...p }) });
  o.plan("kit", [{ id: "1", text: "read" }], { thread: "t-7" });
  o.finish("kit");
  const fin = got.filter(e => e.type === "chrome.finished");
  assert.equal(fin.length, 1);
  assert.deepEqual([fin[0].agent, fin[0].run, fin[0].ok], ["kit", "t-7", true]);
  o.plan("kit", [{ id: "1", text: "read" }], { thread: "t-8" });
  o.finish("kit", { ok: false });
  assert.equal(got.filter(e => e.type === "chrome.finished").pop().ok, false);
  o.plan("kit", [{ id: "1", text: "read" }], { thread: "t-9" });
  o.stop({ by: "esc" });
  const last = got.filter(e => e.type === "chrome.finished").pop();
  assert.deepEqual([last.run, last.ok, last.stopped], ["t-9", false, true]);
});

test("oversight: stop, resume, interject and pause take an optional run: the active run or nothing, never another", () => {
  const { os } = rig();
  os.plan("kit", STEPS, { thread: "t-A" });
  os.plan("pax", STEPS, { thread: "t-B" });
  // the active run is the one that planned last
  assert.throws(() => os.interject({ text: "hi", run: "t-A" }), { code: "not_found" });
  assert.doesNotThrow(() => os.interject({ text: "hi", run: "t-B" }));
  assert.doesNotThrow(() => os.interject({ text: "again" }), "omitted means the active run");
  assert.throws(() => os.interject({ text: "x", run: "nope" }), { code: "not_found" });
  assert.throws(() => os.pause({ run: "t-A" }), { code: "not_found" });
  assert.throws(() => os.stop({ run: "t-A" }), { code: "not_found" });
  return os.stop({ run: "t-B" }).then(() => { assert.throws(() => os.resume({ run: "t-A" }), { code: "not_found" }); assert.doesNotThrow(() => os.resume({ run: "t-B" })); });
});
