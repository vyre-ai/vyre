// @ts-check
import "../mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestions, acceptable, generateQuestions, textOfSession } from "./realuse.js";

const S1 = { id: "s1", turns: [{ role: "user", text: "Please move the staging port to 41873 and tag the fix 9c41e7a." }, { role: "assistant", text: "Done: staging listens on 41873, the fix is commit 9c41e7a." }] };
const S2 = { id: "s2", turns: [{ role: "user", text: "Use branch work/chat for the chat module and keep the retry delay at 125 seconds." }] };
const texts = [S1, S2].map(textOfSession);

test("parseQuestions reads the asked JSON and nothing else", () => {
  assert.deepEqual(parseQuestions('Here: [{"q":"What port?","expect":["41873"]}] done'), [{ q: "What port?", expect: ["41873"] }]);
  assert.deepEqual(parseQuestions("no json here"), []);
  assert.deepEqual(parseQuestions('[{"q":1}]'), []);
});

test("acceptable: the answer is in the session, not in the question, not boilerplate, and the question stands alone", () => {
  const good = { q: "Which port did the staging server move to?", expect: ["41873"] };
  assert.ok(acceptable(good, texts[0], texts));
  assert.ok(!acceptable({ q: "Which port did staging move to in 41873?", expect: ["41873"] }, texts[0], texts), "the answer is in the question");
  assert.ok(!acceptable({ q: "What port does the transcript say staging uses?", expect: ["41873"] }, texts[0], texts), "points at the transcript");
  assert.ok(!acceptable({ q: "Which port did the staging server move to?", expect: ["50000"] }, texts[0], texts), "not in the text");
  assert.ok(!acceptable({ q: "Which word comes after the done marker?", expect: ["done"] }, texts[0], texts), "a common word");
  const dup = [texts[0], texts[0], texts[0]];
  assert.ok(!acceptable(good, texts[0], dup), "stated in more than two sessions");
});

test("generateQuestions keeps verified questions, spreads across sessions, and drops the rest", async () => {
  const replies = [
    JSON.stringify([{ q: "Which port did the staging server move to?", expect: ["41873"] }, { q: "Which commit tagged the staging port fix?", expect: ["9c41e7a"] }, { q: "What colour is the logo today?", expect: ["blue"] }]),
    JSON.stringify([{ q: "Which branch holds the chat module work?", expect: ["work/chat"] }]),
  ];
  let i = 0;
  const model = { call: async () => ({ text: replies[i++], usd: 0, tin: 1, tout: 1 }) };
  const qs = await generateQuestions(model, [S1, S2], 3);
  assert.deepEqual(qs.map(q => q.session), ["s1", "s2", "s1"], "round-robin across sessions");
  assert.ok(qs.every(q => q.class === "history"));
  assert.ok(!qs.some(q => /logo/.test(q.q)), "an unverifiable answer is dropped");
});
