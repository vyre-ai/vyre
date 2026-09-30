// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, shapeReply, ask } from "./memory-ask.js";

test("looksLikeQuestion: a question mark or a question word with a few words, not a keyword", () => {
  for (const q of ["what did we decide about pricing", "who is Dana?", "did I send the invoice"]) assert.equal(looksLikeQuestion(q), true, q);
  for (const q of ["pricing", "what is", "invoice dana", ""]) assert.equal(looksLikeQuestion(q), false, q);
});

test("shapeReply: an answer with its sources, an abstain, a limit", () => {
  assert.deepEqual(shapeReply({ abstained: false, answer: " Tuesday ", sources: [{ name: "Launch" }, { session: "s1" }, { name: "Launch" }] }), { kind: "answer", text: "Tuesday", note: "", sources: ["Launch", "s1"] });
  assert.deepEqual(shapeReply({ abstained: true, known: "It knows your projects." }), { kind: "unsure", text: "Not sure yet.", note: "It knows your projects.", sources: [] });
  assert.equal(shapeReply({ abstained: false, answer: "   " }).kind, "unsure");
  assert.equal(shapeReply({ limited: true, message: "Try tomorrow." }).text, "Try tomorrow.");
  assert.equal(shapeReply(null).kind, "unsure");
});

test("ask: one memory.ask call; a missing module or a refusal is words, not a throw", async () => {
  /** @type {any[]} */ const seen = [];
  const r = await ask(async (n, i) => { seen.push([n, i]); return { data: { abstained: false, answer: "Yes", sources: [] } }; }, "did I?");
  assert.deepEqual(seen, [["memory.ask", { question: "did I?" }]]);
  assert.equal(/** @type {any} */ (r).text, "Yes");
  assert.match(String(/** @type {any} */ (await ask(async () => ({ error: { missing: true } }), "q")).error), /not running/);
  assert.equal(/** @type {any} */ (await ask(async () => ({ error: new Error("boom") }), "q")).error, "boom");
});
