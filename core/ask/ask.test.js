// @ts-check
// One card for every question: what an agent may ask, what a person's answers must be, and the flow on a real daemon (ask, wait, answer, the agent hears; a model cannot answer for the person).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { cleanQuestions, checkAnswers, answerLines } from "./model.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const QS = [
  { id: "file", prompt: "Is this the file?", choices: [{ label: "report-final.pdf", detail: "Downloads, 2 MB" }, "report-v2.pdf"] },
  { prompt: "Which Sam?", choices: ["Sam Lee, Slack", "Sam K."], allowText: true },
  { prompt: "Add a note?", choices: [], allowText: true, optional: true },
];

test("questions are cleaned: one to six, each with choices or room to type, ids made unique", () => {
  const qs = cleanQuestions(QS);
  assert.deepEqual(qs.map(q => q.id), ["file", "q2", "q3"]);
  assert.deepEqual(qs[0].choices[0], { label: "report-final.pdf", detail: "Downloads, 2 MB" });
  assert.equal(qs[2].optional, true);
  assert.throws(() => cleanQuestions([]), /at least one/);
  assert.throws(() => cleanQuestions(Array.from({ length: 7 }, () => ({ prompt: "x", choices: ["a"] }))), /at most 6/);
  assert.throws(() => cleanQuestions([{ prompt: "x", choices: [], allowText: false }]), /no choices and no room/);
  assert.throws(() => cleanQuestions([{ choices: ["a"] }]), /needs its words/);
  assert.deepEqual(cleanQuestions([{ id: "a", prompt: "x", choices: ["1"] }, { id: "a", prompt: "y", choices: ["1"] }]).map(q => q.id), ["a", "a_2"]);
});

test("answers are checked: a choice by its label or the person's own words; every question not optional needs one", () => {
  const qs = cleanQuestions(QS);
  const ok = checkAnswers(qs, { file: { choice: "report-final.pdf" }, q2: { text: "the one in sales" } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.answers, { file: { choice: "report-final.pdf" }, q2: { text: "the one in sales" } });
  assert.match(String(!checkAnswers(qs, { file: { choice: "report-final.pdf" } }).ok && /** @type {any} */ (checkAnswers(qs, { file: { choice: "report-final.pdf" } })).error), /Which Sam/);
  assert.equal(checkAnswers(qs, { file: { choice: "something else" }, q2: { text: "x" } }).ok, false);
  assert.equal(checkAnswers(cleanQuestions([{ prompt: "p", choices: ["a"], allowText: false }]), { q1: { text: "own" } }).ok, false, "a question that takes a choice does not take typed words");
  assert.deepEqual(answerLines(qs, ok.ok ? ok.answers : {}), ["Is this the file? report-final.pdf", "Which Sam? the one in sales"]);
});

test("ask.many shows one card, waits, and the agent hears the person's answers; a model cannot answer, an answered card is closed", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);

  // an agent asks (it would wait for the answers; here it does not) and the person answers
  const second = await call("ask.many", { title: "Another", questions: [{ prompt: "ok?", choices: ["yes"] }] }, "mcp");
  assert.equal(second.data.state, "waiting");
  assert.ok(/^[0-9a-f]{12}$/.test(second.data.id));
  assert.equal((await call("ask.answer", { id: second.data.id, answers: { q1: { choice: "yes" } } }, "mcp")).error.code !== undefined, true, "a model does not answer for the person");
  assert.ok((await call("ask.answer", { id: second.data.id, answers: {} })).error, "an incomplete answer is refused and says what is missing");
  const done = await call("ask.answer", { id: second.data.id, answers: { q1: { choice: "yes" } } });
  assert.equal(done.data.state, "answered");
  assert.deepEqual(done.data.lines, ["ok? yes"]);
  assert.equal((await call("ask.answer", { id: second.data.id, answers: { q1: { choice: "yes" } } })).error.code, "conflict", "answered once");
  const heard = await call("ask.get", { id: second.data.id, wait_ms: 1000 }, "mcp");
  assert.equal(heard.data.state, "answered");
  // a card nobody answered stays waiting until it is cancelled
  const firstWaiting = await call("ask.many", { questions: [{ prompt: "p", choices: ["a"] }], wait_ms: 0 });
  assert.equal(firstWaiting.data.state, "waiting");
  const cancelled = await call("ask.cancel", { id: firstWaiting.data.id });
  assert.equal(cancelled.data.state, "cancelled");
  assert.equal((await call("ask.get", { id: "nope" }, "mcp")).error.code, "not_found");
});
