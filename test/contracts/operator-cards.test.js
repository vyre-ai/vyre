// @ts-check
// Contract test for team/contracts/operator-cards.md (v1): the real tools and events on a real daemon, against the fixtures a consumer builds with.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { tempHome, present, asOwner } from "../helpers.js";
import { operatorFixtures as F, THREAD, shapeDiff } from "./operator-cards.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("operator-cards v1: the run, sign-in and question cards keep the shapes the fixtures promise", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  /** @type {Record<string, any[]>} */ const heard = { "thread.operator": [], "thread.signin": [], "thread.questions": [] };
  for (const type of Object.keys(heard)) d.events.on(type, (/** @type {any} */ e) => { if (e.thread === THREAD) heard[type].push(e.payload); });
  const last = (/** @type {string} */ type) => heard[type][heard[type].length - 1];

  // ---- the run card
  const op = await call("previews.operator", F.calls.operator.input, "module:computer");
  assert.equal(shapeDiff(op.data, F.calls.operator.output), "", JSON.stringify(op));
  assert.match(op.data.run, /^[0-9a-f]{12}$/);
  const run = op.data.run;
  assert.equal(shapeDiff(last("thread.operator"), { ...F.events["thread.operator"], steps: [] }), "", "the first card has no steps yet");
  assert.equal(last("thread.operator").line, "Getting started");
  const step = await call("previews.step", { ...F.calls.step.input, run }, "module:computer");
  assert.equal(shapeDiff(step.data, F.calls.step.output), "", JSON.stringify(step));
  assert.equal(shapeDiff(last("thread.operator"), F.events["thread.operator"]), "");
  assert.deepEqual(last("thread.operator").steps, [{ line: "Opening the workflow list", state: "working" }]);
  for (let i = 0; i < 9; i++) await call("previews.step", { run, line: "x".repeat(300) }, "module:computer");
  assert.equal(last("thread.operator").steps.length, F.limits.steps, "only the last seven steps travel");
  assert.equal(last("thread.operator").line.length, F.limits.stepLine, "a line is cut at 160 characters");
  assert.deepEqual(F.states.operator.map(s => s), ["working", "done", "stuck", "paused"]);

  // a stuck run asks for what it needs; only a person's reply reaches it
  await call("previews.step", { ...F.calls.stuck.input, run }, "module:computer");
  assert.equal(last("thread.operator").state, "stuck");
  assert.equal(last("thread.operator").ask, F.calls.stuck.input.ask);
  const pending = call("previews.run-get", { run, wait_ms: 10_000 }, "module:computer");
  await new Promise(r => setTimeout(r, 100));
  assert.ok((await call("previews.reply", { run, text: "123456" }, "mcp")).error, "a model never replies for the person");
  assert.equal((await call("previews.reply", { run, text: "  " })).error.code, "bad_input");
  assert.equal((await call("previews.reply", { run, text: "123456" })).data.state, "working");
  const got = await pending; assert.equal(shapeDiff(got.data, F.calls.runGet.output), "", JSON.stringify(got));
  assert.equal(last("thread.operator").ask, "", "the box to type in goes away once answered");

  // a model moves only a card of its own chat
  assert.equal((await call("previews.step", { run, line: "x" }, "mcp", { thread: "thr_other" })).error.code, "not_found");
  assert.equal((await call("previews.run-get", { run }, "mcp", { thread: "thr_other" })).error.code, "not_found");
  assert.equal((await call("previews.operator", { computer: "bad name!" }, "module:computer")).error.code, "bad_input");

  // ---- the sign-in card
  const si = await call("previews.signin", F.calls.signin.input, "module:computer");
  assert.equal(shapeDiff(si.data, F.calls.signin.output), "", JSON.stringify(si));
  assert.equal(shapeDiff(last("thread.signin"), F.events["thread.signin"]), "");
  assert.ok((await call("previews.signin-done", { id: si.data.id }, "mcp")).error, "a model does not sign in for the person");
  assert.equal((await call("previews.signin-done", { id: si.data.id })).data.state, "done");
  assert.equal(last("thread.signin").state, "done");
  assert.equal((await call("previews.signin-get", { id: si.data.id }, "module:computer")).data.state, "done");

  // ---- the question card
  const asked = await call("ask.many", F.calls.ask.input, "module:computer");
  assert.equal(shapeDiff(asked.data, F.calls.ask.output), "", JSON.stringify(asked));
  assert.equal(shapeDiff(last("thread.questions"), F.events["thread.questions"]), "");
  assert.ok((await call("ask.answer", { id: asked.data.id, answers: { computer: { choice: "Your Mac" } } }, "mcp")).error, "a model does not answer for the person");
  const answered = await call("ask.answer", { id: asked.data.id, answers: { computer: { choice: "Your Mac" } } });
  assert.equal(answered.data.state, "answered");
  assert.deepEqual(answered.data.answers, F.calls.answered.answers);
  assert.deepEqual(answered.data.lines, F.calls.answered.lines);
  assert.equal(last("thread.questions").state, "answered");
  assert.equal((await call("ask.answer", { id: asked.data.id, answers: { computer: { choice: "Your Mac" } } })).error.code, "conflict");
  assert.equal((await call("ask.get", { id: "nope" }, "module:computer")).error.code, "not_found");
  const other = await call("ask.many", { thread: THREAD, questions: [{ prompt: "p", choices: ["a"] }] }, "module:computer");
  assert.equal((await call("ask.cancel", { id: other.data.id })).data.state, "cancelled");
  assert.equal(last("thread.questions").state, "cancelled");
});
