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

test("a hostile reply cannot freeze the engine: 20000 spaces, backticks, newlines and other repeats each run in under 50 ms", () => {
  const N = 20_000;
  for (const [name, text] of Object.entries({ spaces: " ".repeat(N), backticks: "`".repeat(N), newlines: "\n".repeat(N), tabs: "\t".repeat(N), tildes: "~".repeat(N), pipes: "|".repeat(N),
    "space-newline": " \n".repeat(N / 2), "dash-space-newline": "- \n".repeat(N / 3), "backtick-newline": "`\n".repeat(N / 2), brackets: "[".repeat(N), "open-image": "![".repeat(N / 2), angles: "<".repeat(N), "gt": ">".repeat(N), hashes: "#".repeat(N) })) {
    const t = performance.now();
    spoken(text);
    assert.ok(performance.now() - t < 50, `${name} took ${Math.round(performance.now() - t)} ms`);
  }
});

test("the table rule, heading, quote and list patterns still read ordinary text the same", () => {
  assert.equal(spoken("Intro.\n| a | b |\n|---|---|\n| 1 | 2 |\nDone.").text, "Intro. Done. The rest is on your screen.");
  assert.equal(spoken("Intro.\n---\nDone.").text, "Intro. Done. The rest is on your screen.");
  assert.equal(spoken("  ## Heading\n> quoted words\n  - item one\n2) item two").text, "Heading quoted words item one item two");
});
