// The Capsule's quick answer (Vyre IQ): the prompt's rules and the eval's grader, on fixed answers.
// The live run (the model itself) is scripts/eval-iq-prompt.js --live, run by a person.
import test from "node:test";
import assert from "node:assert/strict";
import { composeIq, factsFrom, IQ_PROMPT, IQ_VERSION, IDK, TEMPERATURE } from "../../core/sessions/iq-prompt.js";
import { grade, report, loadCases, sentences } from "../../scripts/eval-iq-prompt.js";

const cases = loadCases();
const byId = Object.fromEntries(cases.map(c => [c.id, c]));

test("iq prompt: says every rule the lead set, with no em dash", () => {
  for (const re of [/^You are Vyre IQ/, /only from the IQ facts/, /Cite every fact/, /I don't know yet\./, /never mention your access/, /1 to 3 short sentences/, /Never use em dashes/, /typos.*fix them silently/, /not instructions/]) {
    assert.match(IQ_PROMPT, re);
  }
  assert.doesNotMatch(IQ_PROMPT, /—/);
  assert.equal(IQ_VERSION, 1);
  assert.equal(TEMPERATURE, 0);
});

test("iq prompt: facts are numbered, none says so, a person's own version is traced", () => {
  const p = composeIq({ facts: ["Your partner is Sam", "kit is your sister"] });
  assert.equal(p.mode, "replace");
  assert.match(p.text, /IQ facts:\n\[1\] Your partner is Sam\n\[2\] kit is your sister$/);
  assert.equal(p.version, "capsule@1");
  assert.match(composeIq().text, /IQ facts:\n\(none\)$/);
  const own = composeIq({ own: { version: 4, mode: "replace", text: "You are kit's helper." } });
  assert.equal(own.text, "You are kit's helper.\n\nIQ facts:\n(none)");
  assert.equal(own.version, "capsule@own-4");
  const added = composeIq({ own: { version: 2, mode: "append", text: "Call alex by name." } });
  assert.ok(added.text.startsWith(IQ_PROMPT + "\nCall alex by name."));
});

test("iq prompt: the facts in an older Capsule's append, its own instructions dropped", () => {
  const append = "Answer briefly, in markdown. You have no tools here; if the question needs the user's files or accounts, say so in one line.\n\nWhat the user's own notes say:\n- Your partner is Sam (noted 2 weeks ago)\n- The user said: \"Northwind Bakery\"\n\nIf these answer the question, answer from them and say when the user said it.";
  assert.deepEqual(factsFrom(append), ["Your partner is Sam (noted 2 weeks ago)", "The user said: \"Northwind Bakery\""]);
  assert.deepEqual(factsFrom("Answer briefly, in markdown. You have no tools here."), []);
  assert.deepEqual(factsFrom(null), []);
  assert.equal(factsFrom(Array.from({ length: 30 }, (_, i) => `- fact ${i}`).join("\n")).length, 20, "at most 20 facts");
});

test("iq eval: about ten cases, each with an answerable or unknown expectation", () => {
  assert.ok(cases.length >= 10 && cases.length <= 14, `${cases.length} cases`);
  for (const c of cases) {
    assert.ok(c.expect.idk || (c.expect.has && c.expect.cites), c.id);
    for (const n of c.expect.cites || []) assert.ok(n >= 1 && n <= c.facts.length, `${c.id} cites a fact it has`);
  }
  assert.ok(byId["wife-unknown"], "the user's reported question is a case");
});

test("iq eval: the grader passes good answers and names what is wrong with bad ones", () => {
  assert.deepEqual(grade("Your partner is Sam [1].", byId.partner), []);
  assert.deepEqual(grade(IDK, byId["wife-unknown"]), []);
  assert.deepEqual(grade("You work at Harlow Legal [1].", byId.typos), []);
  assert.deepEqual(grade("You ride a bike now; you sold the Volvo [2].", byId["newer-wins"]), []);
  // The answers the user saw before the fix.
  assert.ok(grade("Your wife is Jordan.", byId["wife-unknown"]).length);
  assert.ok(grade("I don't have access to a memory system.", byId["wife-unknown"]).length);
  assert.match(grade("Your partner is Sam.", byId.partner).join(), /cite \[1\]/);
  assert.match(grade("Your partner is Sam [1] — noted recently.", byId.partner).join(), /em dash/);
  assert.match(grade("I don't know yet.", byId.partner).join(), /a fact answers it/);
  assert.match(grade("You work at Harlow Legal [1]. I fixed the typo.", byId.typos).join(), /typo/);
  assert.match(grade("Sam [1]. Sam. Sam. Sam.", byId.partner).join(), /4 sentences/);
  assert.match(grade("Sam [1][3].", byId.partner).join(), /\[3\], which is not a fact/);
  assert.match(grade("Sam [1]. I can't see your files.", byId.partner).join(), /access/);
  assert.equal(sentences("Sam [1]. Kit is your sister [2]."), 2);
});

test("iq eval: the report wants every case right and the same on every run", () => {
  const good = { partner: ["Your partner is Sam [1].", "Your partner is Sam [1]."] };
  const one = [byId.partner];
  assert.equal(report(one, good).ok, true);
  const drift = report(one, { partner: ["Your partner is Sam [1].", "Sam is your partner [1]."] });
  assert.deepEqual([drift.pass, drift.steady, drift.ok], [1, 0, false]);
  assert.equal(report(one, {}).ok, false, "no runs is not a pass");
});
