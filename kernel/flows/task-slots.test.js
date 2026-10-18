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

test("assign and ask steps take a reviewer, an approver, instructions and skills per slot", () => {
  const slots = { reviewer: "role:editors", approver: "person:per_b", quorum: "any", instructions: { doer: "Keep it short", reviewer: "Check the tone", approver: "Only if it names the firm" }, skills: { doer: ["voice"], reviewer: ["brand-voice"] } };
  assert.deepEqual(problems(flow(assign(slots))), []);
  assert.deepEqual(problems(flow(ask({ reviewer: "teammate:editor", approver: "role:partners", instructions: { approver: "Say yes only if sure" } }))), []);
  assert.deepEqual(problems(flow(assign({ skills: ["probate"] }))), [], "the old list of words still stands for the doer");
});

test("slots are refused when malformed: who, quorum, both approver and checker, a slot the step lacks, repeated or too many skills, a long instruction", () => {
  const bad = (/** @type {any} */ over, /** @type {RegExp} */ re) => assert.match(problems(flow(assign(over))).join("\n"), re);
  bad({ reviewer: "someone" }, /reviewer is person/);
  bad({ approver: "pool:x" }, /approver is person/);
  bad({ quorum: "all" }, /quorum is any/);
  bad({ approver: "person:per_b", checker: "person:per_c" }, /not both/);
  bad({ instructions: { reviewer: "x" } }, /no reviewer/);
  bad({ reviewer: "role:r", skills: { reviewer: ["a", "a"] } }, /different Space skill ids/);
  bad({ skills: { doer: Array.from({ length: 11 }, (_, i) => `s${i}`) } }, /up to 10/);
  bad({ instructions: { doer: "x".repeat(2001) } }, /2000/);
  bad({ instructions: { mayor: "x" } }, /not part of this/);
  assert.match(problems(flow(ask({ skills: ["a"] }))).join("\n"), /skills on a question/);
});
