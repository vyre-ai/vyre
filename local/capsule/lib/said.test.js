// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSaid, yourAnswer, isQuestion, MAX_SAID } from "./said.js";

const Q = "which car do I own";
// What recall.search gave for the question, in its order, when the user tried it: the question
// echoed back, a dev session talking about the test, an unrelated quote, and the answer last.
const HITS = [
  { session: "c1", role: "user", name: "Capsule: which car do I own", cwd: "/home/alex/.vyre/capsule/ask", text: "which car do I own" },
  { session: "e1", role: "user", name: "Errands", cwd: "/home/alex/Work", text: "which car do I own?" },
  { session: "d1", role: "assistant", name: "Capsule memory test", cwd: "/home/alex/Work/vyre", text: "Asking which car do I own should answer blue Volvo XC40 from the insurance note." },
  { session: "u1", role: "user", name: "Office", cwd: "/home/alex/Work", text: "The car park at the office closes at 10." },
  { session: "a1", role: "user", name: "Insurance renewal", cwd: "/home/alex/Work", text: "I own a blue Volvo XC40, bought in 2022. Renew the insurance before March." },
];

test("said: the question echoed back, the Capsule's own threads and talk about the question are out; the statement is first", () => {
  const got = rankSaid(HITS, Q, { scratch: "/home/alex/.vyre/capsule/ask" });
  assert.deepEqual(got.map(h => h.session), ["a1", "u1"]);
  assert.ok(got.length <= MAX_SAID);
});

test("said: a Capsule thread is known by its name even outside the scratch folder", () => {
  assert.deepEqual(rankSaid([{ role: "assistant", name: "Capsule: which car do I own", text: "I can't see your files." }], Q).length, 0);
});

test("said: questions and Claude's words go below the user's own statements", () => {
  const got = rankSaid([
    { session: "q", role: "user", text: "do I need a new car battery?" },
    { session: "c", role: "assistant", text: "Your car insurance renews in March." },
    { session: "s", role: "user", text: "My car is the blue Volvo." },
  ], Q);
  assert.deepEqual(got.map(h => h.session), ["s", "c"]);
});

test("said: a clear first-person statement becomes one line about the user; anything else is not an answer", () => {
  assert.equal(yourAnswer(HITS[4], Q), "You own a blue Volvo XC40, bought in 2022.");
  assert.equal(yourAnswer({ role: "user", text: "My car is the blue Volvo." }, Q), "Your car is the blue Volvo.");
  assert.equal(yourAnswer({ role: "user", text: "I'm driving my car to Harlow." }, Q), "You're driving your car to Harlow.");
  assert.equal(yourAnswer(HITS[3], Q), null, "not about the user");
  assert.equal(yourAnswer({ role: "assistant", text: "I own nothing." }, Q), null, "Claude's words are not the user's");
  assert.equal(yourAnswer({ role: "user", text: "I wonder which car do I own?" }, Q), null, "a question is not an answer");
  assert.equal(yourAnswer({ role: "user", text: "I like tea." }, Q), null, "shares no word with the question");
  assert.equal(yourAnswer(undefined, Q), null);
  assert.ok(isQuestion("do I own it") && !isQuestion("I own it."));
});
