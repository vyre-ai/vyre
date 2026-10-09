// @ts-check
import "../../mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateModel } from "./fit.js";
import { scripted } from "./scripted.js";
import { NATIVE_TASKS, buildNativeFixture } from "./native.js";
import { nativeAgent, shellAgent, guessesTimeline, claimsSent } from "./native-scripted.js";

const run = (/** @type {any} */ adapter) => evaluateModel({ adapter, kernelFixture: buildNativeFixture, tasks: NATIVE_TASKS });
const by = (/** @type {any} */ r, /** @type {string} */ id) => r.tasks.find((/** @type {any} */ t) => t.id === id);

test("the agent is told only the environment brief: it names Vyre's families and never tells it to use a tool for a job", async () => {
  const fx = await buildNativeFixture();
  assert.match(fx.system, /Vyre/);
  assert.match(fx.system, /Records/i);
  for (const t of NATIVE_TASKS) assert.ok(!/(records|flows|skills|timeline|email\.send)/i.test(t.prompt), `${t.id}: the prompt must not name a Vyre tool`);
  assert.deepEqual(NATIVE_TASKS.map(t => t.id), ["record", "timeline", "flow", "send", "skill"]);
});

test("an agent that reaches for Vyre's way each time scores 100 of 100", async () => {
  const r = await run(scripted("native", nativeAgent));
  assert.deepEqual(r.tasks.map(t => [t.id, t.score]), [["record", 20], ["timeline", 20], ["flow", 20], ["send", 20], ["skill", 20]]);
});

test("an agent that does everything with the shell fails the jobs that have a Vyre way", async () => {
  const r = await run(shellAgent);
  for (const id of ["record", "flow", "send", "skill"]) assert.ok(by(r, id).score <= 6, `${id}: ${by(r, id).notes.join("; ")}`);
  assert.match(by(r, "send").notes.join(), /shell/);
});

test("an agent that guesses the timeline loses that task only", async () => {
  const r = await run(guessesTimeline);
  assert.ok(by(r, "timeline").score <= 4);
  assert.equal(r.tasks.filter(t => t.score === 20).length, 4);
});

test("an agent that says the mail was sent while it is held loses the send points it should not have", async () => {
  const r = await run(claimsSent);
  assert.ok(by(r, "send").score < 20);
  assert.match(by(r, "send").notes.join(), /said it was sent/);
});
