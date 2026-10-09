// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spoken, MAX_SPOKEN, MAX_INPUT } from "./spoken.js";

test("plain prose is said as written", () => {
  assert.deepEqual(spoken("Northwind Bakery opens at nine. I set a reminder for eight."), { text: "Northwind Bakery opens at nine. I set a reminder for eight.", cut: false });
});

test("markdown is reduced to its words; links, code and tables cannot be said", () => {
  const r = spoken("## Plan\n\n- **Call** Jordan at 4\n- See [the brief](https://example.org/a/b?c=d) and `vyre status`\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.ok(r.cut);
  assert.match(r.text, /^Plan Call Jordan at 4 See the brief and vyre status/);
  assert.match(r.text, /The rest is on your screen\.$/);
  assert.doesNotMatch(r.text, /https|const x|\||```|\*\*/);
});

test("a bare URL becomes 'a link'", () => {
  assert.match(spoken("Open https://example.org/very/long/path now.").text, /^Open a link now\./);
});

test("a long reply is its first sentences, cut at a sentence end, inside the limit, with the note", () => {
  const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const r = spoken(long);
  assert.ok(r.cut);
  assert.ok(r.text.length <= MAX_SPOKEN, String(r.text.length));
  assert.match(r.text, /Sentence number 0 is here\. Sentence number 1 is here\./);
  assert.match(r.text, /here\. The rest is on your screen\.$/);
});

test("one very long sentence is cut at a word, never mid-word", () => {
  const r = spoken("word ".repeat(400).trim());
  assert.ok(r.cut && r.text.length <= MAX_SPOKEN);
  assert.doesNotMatch(r.text, /wor(?!d)\b.*screen/);
});

test("nothing speakable records nothing to say", () => {
  assert.deepEqual(spoken("```\nonly code\n```"), { text: "", cut: false });
  assert.deepEqual(spoken("   "), { text: "", cut: false });
  assert.deepEqual(spoken(null), { text: "", cut: false });
});

test("only the first 20000 characters are read, so a huge reply is quick and still cut at a sentence", () => {
  const huge = "Sentence here. ".repeat(200_000);
  const t = Date.now();
  const r = spoken(huge);
  assert.ok(Date.now() - t < 1000);
  assert.ok(r.cut && r.text.length <= MAX_SPOKEN);
  assert.equal(MAX_INPUT, 20_000);
});

test("a hostile reply cannot freeze the engine: 20000 spaces, backticks, newlines and other repeats cost work in proportion to their size", () => {
  const N = 20_000;
  const makers = { spaces: n => " ".repeat(n), backticks: n => "`".repeat(n), newlines: n => "\n".repeat(n), tabs: n => "\t".repeat(n), tildes: n => "~".repeat(n), pipes: n => "|".repeat(n),
    "space-newline": n => " \n".repeat(n / 2), "dash-space-newline": n => "- \n".repeat(n / 3), "backtick-newline": n => "`\n".repeat(n / 2), brackets: n => "[".repeat(n), "open-image": n => "![".repeat(n / 2), angles: n => "<".repeat(n), gt: n => ">".repeat(n), hashes: n => "#".repeat(n) };
  // Best of three, then the same input at a quarter of the size: linear work is four times as slow at four times the size, a quadratic blow-up sixteen times, and a loaded machine slows both sizes alike,
  // so the ratio holds where a fixed number of milliseconds did not (the bracket and image patterns alone take about 65 ms for 20000 characters on an idle machine).
  const best = text => { let b = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); spoken(text); b = Math.min(b, performance.now() - t); } return b; };
  for (const [name, make] of Object.entries(makers)) {
    const big = best(make(N)), small = best(make(N / 4));
    assert.ok(big < 30 || big / Math.max(small, 2) < 10, `${name}: ${big.toFixed(0)} ms at ${N} characters but ${small.toFixed(0)} ms at ${N / 4}`);
    assert.ok(big < 20_000, `${name} took ${big.toFixed(0)} ms`);
  }
});

test("the table rule, heading, quote and list patterns still read ordinary text the same", () => {
  assert.equal(spoken("Intro.\n| a | b |\n|---|---|\n| 1 | 2 |\nDone.").text, "Intro. Done. The rest is on your screen.");
  assert.equal(spoken("Intro.\n---\nDone.").text, "Intro. Done. The rest is on your screen.");
  assert.equal(spoken("  ## Heading\n> quoted words\n  - item one\n2) item two").text, "Heading quoted words item one item two");
});
