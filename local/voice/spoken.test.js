// @ts-check
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

test("a reply of nothing but blanks, newlines or fences cannot stall the loop (reviewer-2: 20000 spaces took 23 s)", () => {
  const shapes = {
    spaces: " ".repeat(MAX_INPUT) + "x",
    newlines: "\n".repeat(MAX_INPUT),
    ticks: "`".repeat(MAX_INPUT),
    tabs: "\t".repeat(MAX_INPUT) + "x",
    pipes: "|".repeat(MAX_INPUT),
    rules: "- ".repeat(MAX_INPUT / 2),
    quotes: "> ".repeat(MAX_INPUT / 2),
    spacedNewlines: " \n".repeat(MAX_INPUT / 2) + "x",
  };
  for (const [name, text] of Object.entries(shapes)) {
    const t0 = performance.now();
    spoken(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${name} took ${ms.toFixed(1)} ms`);
  }
});

test("indented table rules and list markers still go", () => {
  const r = spoken("Intro line.\n  | a | b |\n  |---|---|\n  - one\n  > quoted\nDone.");
  assert.doesNotMatch(r.text, /\||---/);
  assert.match(r.text, /Intro line\. one quoted Done\./);
});
