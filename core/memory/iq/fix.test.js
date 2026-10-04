// @ts-check
// iq/fix: correcting a Vyre Memory answer where it is shown, remembered, and undone.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../../store/index.js";
import { MIGRATIONS } from "../schema.js";
import { tempHome } from "../../../test/helpers.js";
import { fixes, questionKey, answerId, questionKind } from "./fix.js";
import { asker } from "./ask.js";

function db(t) {
  const d = open(path.join(tempHome(t), "vyre.db"));
  migrate(d, "memory", MIGRATIONS);
  t.after(() => d.close());
  return d;
}

const P = [
  { session: "s1", seq: 3, role: "assistant", ts: Date.parse("2026-06-12T10:00:00Z"), name: "Northwind invoices", text: "Deployed the Northwind staging site on port 8443." },
  { session: "s2", seq: 1, role: "user", ts: Date.parse("2026-06-20T10:00:00Z"), name: "Harlow site", text: "dana wants the intake form above the fold" },
];
const reply = (answer, cite = [1]) => JSON.stringify({ answer, cite, confidence: 0.9, abstain: false, known: [] });

test("fix: a question's key ignores case and punctuation; an answer's id is stable", () => {
  assert.equal(questionKey("What's my wife's name?"), questionKey("whats my wifes name"));
  assert.equal(answerId("Which port?", "8443", ["s1:3"]), answerId("which port", "8443", ["s1:3"]));
  assert.notEqual(answerId("which port", "8443", ["s1:3"]), answerId("which port", "9443", ["s1:3"]));
  assert.equal(questionKind("what is my wife's name"), "people");
  assert.equal(questionKind("when is the Harlow filing deadline"), "date");
});

test("fix: replace answers the same question at once, wrong is never given again, forget drops the turns, undo restores", async t => {
  const d = db(t);
  let calls = 0, text = reply("Port 8443.");
  const f = fixes({ db: d });
  const ask = asker({ db: d, answer: async () => ({ answer: null }), retrieve: async () => ({ passages: P }), runner: async () => { calls++; return { text, usd: 0 }; }, fixes: f });

  const first = await ask({ question: "Which port did Northwind staging use?", personal: true });
  assert.equal(first.answer, "Port 8443.");
  assert.match(first.answer_id, /^a_[0-9a-f]{16}$/);
  assert.equal((await ask({ question: "which port did northwind staging use" })).answer_id, first.answer_id, "the same answer has the same id");

  // replace: the person's words, with no model call, and a source that says so.
  const fix = f.add({ answer: first.answer_id, action: "replace", text: "It moved to port 9443." });
  const before = calls;
  const fixedAns = await ask({ question: "Which port did Northwind staging use?", personal: true });
  assert.equal(fixedAns.answer, "It moved to port 9443.");
  assert.equal(fixedAns.via, "corrected");
  assert.equal(fixedAns.sources[0].name, "your correction");
  assert.equal(calls, before);
  f.undo(fix.id);
  assert.equal((await ask({ question: "Which port did Northwind staging use?", personal: true })).answer, "Port 8443.", "undone: the old answer is back");

  // wrong: that answer is not given to that question again; another question is untouched.
  f.add({ answer: first.answer_id, action: "wrong" });
  const no = await ask({ question: "Which port did Northwind staging use?", personal: true });
  assert.equal(no.answer, null);
  assert.equal(no.abstained, true);
  assert.deepEqual(no.known, ['You said "Port 8443." is wrong.']);
  assert.equal((await ask({ question: "what port is staging on", personal: true })).answer, "Port 8443.");

  // forget: the turns behind the answer never ground one again.
  const other = await ask({ question: "what port is staging on", personal: true });
  f.add({ answer: other.answer_id, action: "forget" });
  assert.ok(f.forgotten().has("s1:3"));
  text = reply("Port 8443.", [1]);
  const gone = await ask({ question: "what port is staging on", personal: true });
  assert.notEqual(gone.sources?.[0]?.session, "s1", "a forgotten turn is not read");

  const week = f.week();
  assert.equal(week.corrected, 2, "the undone fix does not count");
  assert.equal(f.list({ all: true }).length, 3);
  assert.throws(() => f.add({ answer: "a_nope", action: "wrong" }), /no answer a_nope/);
  assert.throws(() => f.add({ answer: first.answer_id, action: "replace", text: " " }), /needs the right answer/);
});
