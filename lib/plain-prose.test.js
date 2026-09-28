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

test("normalizeProse: no hang on a long, adversarial message (100 KB of stray backticks and dashes)", () => {
  const long = "`a—b ".repeat(10_000);
  assert.ok(long.length >= 50_000, `fixture is ${long.length} bytes`);
  const start = process.hrtime.bigint();
  normalizeProse(long);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 50, `normalizeProse took ${ms}ms on a stray-backtick adversarial string`);
});

test("PATTERNS: every entry compiles as a RegExp, em-dash is first", () => {
  assert.equal(PATTERNS[0].id, "em-dash");
  for (const p of PATTERNS) assert.doesNotThrow(() => new RegExp(p.pattern, p.flags));
  assert.ok(new RegExp(PATTERNS[0].pattern, PATTERNS[0].flags).test("a — b"));
});

// reviewer LOW (4732c3a8): a surface runs PATTERNS on a finished message it did not write, so
// none of them may hide catastrophic backtracking. Every pattern here is already linear (no
// nested or overlapping quantifiers), and this pins that down with a real clock on adversarial
// input, not just a read of the regex source.
test("PATTERNS: no pattern hangs on a long, adversarial message (100 KB, under 50ms each)", () => {
  const long = "it's not quite right, it's ".repeat(4000) // targets not-x-its-y's own {0,80} span
    + "delve leverage utilize ".repeat(1000)
    + "—".repeat(1000);
  assert.ok(long.length > 100_000, `fixture is ${long.length} bytes`);
  for (const p of PATTERNS) {
    const re = new RegExp(p.pattern, p.flags);
    const start = process.hrtime.bigint();
    re.test(long);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 50, `${p.id} took ${ms}ms on a 100 KB adversarial string`);
  }
});
