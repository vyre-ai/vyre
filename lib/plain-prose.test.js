// @ts-check
// lib/plain-prose.js: the em-dash hard guarantee (docs/adr/0037-style.md item 3). Pure, no
// daemon needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, splitProse, normalizeProse } from "./plain-prose.js";

test("normalizeProse: a single em dash becomes a comma", () => {
  assert.equal(normalizeProse("the fix works — tested on testbox"), "the fix works, tested on testbox");
});

test("normalizeProse: a paired em dash (the aside form) becomes parentheses", () => {
  assert.equal(normalizeProse("the fix — tested on testbox — shipped today"), "the fix (tested on testbox) shipped today");
});

test("normalizeProse: text with no em dash is returned as-is", () => {
  const s = "nothing to change here";
  assert.equal(normalizeProse(s), s);
});

test("normalizeProse: never touches a fenced code block", () => {
  const s = "before — after\n```js\nconst x = 1; // a — b\n```\nmore — text";
  const out = normalizeProse(s);
  assert.match(out, /const x = 1; \/\/ a — b/, "the em dash inside the fence must survive untouched");
  assert.match(out, /^before, after/);
  assert.match(out, /more, text$/);
  const outsideFence = out.replace(/```[\s\S]*?```/, "");
  assert.ok(!outsideFence.includes("—"), "no em dash should survive outside the fence");
});

test("normalizeProse: never touches inline code", () => {
  const out = normalizeProse("run `git log — oneline` — it works");
  assert.match(out, /`git log — oneline`/, "inline code's em dash must survive");
  assert.match(out, /, it works$/);
});

test("normalizeProse: a dash with no surrounding spaces is still caught", () => {
  assert.equal(normalizeProse("done—no spaces around it"), "done, no spaces around it");
});

test("normalizeProse: a comma landing right before punctuation is cleaned up, not doubled", () => {
  assert.equal(normalizeProse("it works—."), "it works.");
});

test("normalizeProse: idempotent", () => {
  const once = normalizeProse("a — b — c — d");
  assert.equal(normalizeProse(once), once);
});

test("splitProse: fences and inline code come back as their own \"code\" runs, unmodified", () => {
  const parts = splitProse("a `b` c ```js\nd\n``` e");
  assert.deepEqual(parts.map(p => p.kind), ["prose", "code", "prose", "code", "prose"]);
  assert.equal(parts[1].text, "`b`");
  assert.equal(parts[3].text, "```js\nd\n```");
});

test("PATTERNS: every entry compiles as a RegExp, em-dash is first", () => {
  assert.equal(PATTERNS[0].id, "em-dash");
  for (const p of PATTERNS) assert.doesNotThrow(() => new RegExp(p.pattern, p.flags));
  assert.ok(new RegExp(PATTERNS[0].pattern, PATTERNS[0].flags).test("a — b"));
});
