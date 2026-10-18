// @ts-check
// An assign or ask step names its task's reviewer and approver, and per-slot instructions and Space skills (tasks v2).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "./schema.js";

const flow = (/** @type {any} */ step) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [{ id: "s1", ...step }] });
const assign = (/** @type {any} */ over = {}) => ({ kind: "assign", to: "role:designers", title: "Draft", output: { kind: "note" }, ...over });
const ask = (/** @type {any} */ over = {}) => ({ kind: "ask", to: "person:per_a", title: "Ok?", ...over });
const problems = (/** @type {any} */ f) => { const r = /** @type {any} */ (checkFlow(f)); return (Array.isArray(r) ? r : r.problems || r.errors || []).map((/** @type {any} */ x) => `${x.path}: ${x.message}`); };

test("assign and ask steps take a reviewer and an approver, each with its own skills and instructions", () => {
  const slots = { reviewer: { who: "role:editors", skills: ["brand-voice"], instructions: "Check the tone" }, approver: { who: "person:per_b", skills: ["sign-off"], instructions: "Only if it names the firm", quorum: "any" } };
  assert.deepEqual(problems(flow(assign(slots))), []);
  assert.deepEqual(problems(flow(ask({ reviewer: { who: "teammate:editor" }, approver: { who: "role:partners", instructions: "Say yes only if sure" } }))), []);
  assert.deepEqual(problems(flow(assign({ skills: ["probate"] }))), [], "the step's own list of words still stands for the doer");
  assert.deepEqual(problems(flow(assign({ checker: "person:per_c" }))), [], "checker is the old name of the approver");
});

test("slots are refused when malformed: who, quorum, both approver and checker, repeated or too many skills, a long instruction, a stray key", () => {
  const bad = (/** @type {any} */ over, /** @type {RegExp} */ re) => assert.match(problems(flow(assign(over))).join("\n"), re);
  bad({ reviewer: "role:r" }, /reviewer is \{ who/);
  bad({ reviewer: { who: "someone" } }, /reviewer is person/);
  bad({ approver: { who: "pool:x" } }, /approver is person/);
  bad({ approver: { who: "person:per_b", quorum: "all" } }, /quorum is any/);
  bad({ reviewer: { who: "role:r", quorum: "any" } }, /not part of this/);
  bad({ approver: { who: "person:per_b" }, checker: "person:per_c" }, /not both/);
  bad({ reviewer: { who: "role:r", skills: ["a", "a"] } }, /up to 10 different/);
  bad({ reviewer: { who: "role:r", skills: Array.from({ length: 11 }, (_, i) => `s${i}`) } }, /up to 10 different/);
  bad({ approver: { who: "person:per_b", instructions: "x".repeat(2001) } }, /2000/);
});
