// @ts-check
// memory.answer, measured (docs/work/memory-iq.md). Runs scripts/eval-answer.js on the synthetic
// personal world in this process. The harness itself must always work: the world seeded, every
// question asked, the metrics computed for today's Capsule path. Once the memory module has a
// memory.answer tool, it must also clear the bar: overall 0.9 or more, no confident wrong answer,
// and p95 under 150 ms a question.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval, correct } from "../../scripts/eval-answer.js";
import { PERSONAL_SESSIONS, personalWorld } from "../fixtures/personal-world.js";

/** One run for every test below. */
const report = runEval();
report.catch(() => {});   // each test reports the failure itself

const list = a => a.failures.map(f => `  [${f.why}] ${f.q} -> ${f.answer ?? "(none)"}${f.confidence != null ? ` @${f.confidence}` : ""}`).join("\n");

test("answer eval: the world is deterministic and large enough to be realistic", () => {
  assert.deepEqual(personalWorld(), PERSONAL_SESSIONS, "the same seed built a different world");
  assert.ok(PERSONAL_SESSIONS.length >= 120, `only ${PERSONAL_SESSIONS.length} sessions`);
  const turns = PERSONAL_SESSIONS.reduce((n, s) => n + s.turns.length, 0);
  assert.ok(turns >= 1500, `only ${turns} turns`);
  const text = PERSONAL_SESSIONS.flatMap(s => s.turns.map(t => t.text)).join("\n");
  assert.ok(!/[\u2014\u00a7]/.test(text), "an em dash or a section sign in the world");
});

test("answer eval: matching is whole words, case-insensitive", () => {
  assert.equal(correct("You prefer tea.", ["tea"]), true);
  assert.equal(correct("Instead, coffee", ["tea"]), false);
  assert.equal(correct("Her birthday is on the 14th of March.", ["14th of march"]), true);
  assert.equal(correct(null, ["jordan"]), false);
});

test("answer eval: the world is seeded and today's Capsule path is scored", async () => {
  const r = await report;
  assert.equal(r.world.sessions, PERSONAL_SESSIONS.length);
  assert.ok(r.world.questions >= 45, `only ${r.world.questions} questions`);
  assert.ok(r.world.unknowns >= 10, `only ${r.world.unknowns} questions with no answer`);
  const b = r.answerers.before;
  assert.equal(b.supported, true);
  assert.equal(b.questions, r.world.questions);
  for (const k of ["precision_at_1", "no_answer_accuracy", "overall"]) assert.ok(b[k] >= 0 && b[k] <= 1, `${k} is ${b[k]}`);
  assert.ok(Number.isInteger(b.confident_wrong));
  assert.ok(b.p50_ms >= 0 && b.p95_ms >= b.p50_ms);
});

test("answer eval: memory.answer clears the bar", async t => {
  const r = await report;
  const a = r.answerers.answer;
  if (!a.supported) { t.skip(a.reason); return; }
  assert.ok(a.overall >= 0.9, `overall ${a.overall} is under 0.9:\n${list(a)}`);
  assert.equal(a.confident_wrong, 0, `confident wrong answers:\n${list(a)}`);
  assert.ok(a.p95_ms < 150, `p95 ${a.p95_ms} ms is not under 150 ms`);
});

test("answer eval: the same question gives the same answer, and every answer names its source", async t => {
  const r = await report;
  const a = r.answerers.answer;
  if (!a.supported) { t.skip(a.reason); return; }
  assert.equal(a.inconsistent, 0, "an answer changed when the question was asked again");
  assert.equal(a.ungrounded, 0, "an answer told as a fact names no fact or turn");
});

// The "Jordan" trap (ADR 0034, source trust): the user's own words say Noor; dev sessions,
// subagents, injected blocks, Claude and the Capsule say Jordan.
test("answer eval: only the user's own words teach memory who their wife is", async () => {
  const r = await runEval({ world: "trust", only: ["answer"] });
  const a = r.answerers.answer;
  assert.ok(a.supported, a.reason);
  const said = a.answers.map(x => `${x.q} -> ${x.answer}`).join("\n");
  assert.ok(!/jordan/i.test(a.answers.map(x => x.answer || "").join(" ")), `Jordan came back:\n${said}`);
  assert.equal(a.confident_wrong, 0, said);
  assert.equal(a.overall, 1, `${list(a)}`);
  assert.equal(a.inconsistent, 0);
  assert.equal(a.ungrounded, 0);
});
