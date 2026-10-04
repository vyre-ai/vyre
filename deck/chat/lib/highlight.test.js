// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight } from "./highlight.js";

const rebuild = tokens => tokens.map(t => t.text).join("");
const classesOf = tokens => new Set(tokens.filter(t => t.cls).map(t => t.cls));

test("highlight: tokens always reconstruct the original source exactly", () => {
  const samples = [
    ["js", "const x = 1; // one\nfunction f(a) { return a + 1; }"],
    ["json", '{"a": 1, "b": [true, false, null], "c": "x\\"y"}'],
    ["bash", '#!/bin/sh\nif [ "$X" = "1" ]; then echo "$X"; fi'],
    ["css", ".a { color: #fff; margin: 4px; } /* note */"],
    ["html", '<div class="x" onclick="y"><!-- c --></div>'],
    ["python", 'def f(a):\n    # comment\n    return a + 1'],
    ["unknownlang", "whatever <this> is, ${{ not real }}"],
  ];
  for (const [lang, code] of samples) assert.equal(rebuild(highlight(code, lang)), code, `${lang} did not round-trip`);
});

test("highlight: js/javascript and ts/typescript recognize keywords, strings, comments, numbers", () => {
  for (const lang of ["js", "javascript", "ts", "typescript"]) {
    const cls = classesOf(highlight('const x = "hi"; // c\nlet y = 42;', lang));
    assert.ok(cls.has("tok-keyword"), lang);
    assert.ok(cls.has("tok-string"), lang);
    assert.ok(cls.has("tok-comment"), lang);
    assert.ok(cls.has("tok-number"), lang);
  }
});

test("highlight: json recognizes strings, numbers, and true/false/null as keywords", () => {
  const cls = classesOf(highlight('{"a": 1, "b": true}', "json"));
  assert.ok(cls.has("tok-string"));
  assert.ok(cls.has("tok-number"));
  assert.ok(cls.has("tok-keyword"));
});

test("highlight: bash/sh recognize keywords, strings, comments, and $vars", () => {
  for (const lang of ["bash", "sh"]) {
    const cls = classesOf(highlight('if [ "$X" = "1" ]; then echo $X; fi # done', lang));
    assert.ok(cls.has("tok-keyword"), lang);
    assert.ok(cls.has("tok-string"), lang);
    assert.ok(cls.has("tok-comment"), lang);
    assert.ok(cls.has("tok-function"), lang); // $vars
  }
});

test("highlight: css recognizes comments, at-rules, and hex colors", () => {
  const cls = classesOf(highlight("@media (min-width: 100px) { .a { color: #FF00FF; } } /* c */", "css"));
  assert.ok(cls.has("tok-comment"));
  assert.ok(cls.has("tok-keyword"));
  assert.ok(cls.has("tok-number"));
});

test("highlight: html recognizes tags, comments, and quoted attribute values", () => {
  const cls = classesOf(highlight('<div class="a"><!-- c --></div>', "html"));
  assert.ok(cls.has("tok-keyword"));
  assert.ok(cls.has("tok-comment"));
  assert.ok(cls.has("tok-string"));
});

test("highlight: python recognizes keywords, strings, comments, numbers, function defs", () => {
  const cls = classesOf(highlight('def f(a):\n    # c\n    return a + 3.5', "python"));
  assert.ok(cls.has("tok-keyword"));
  assert.ok(cls.has("tok-comment"));
  assert.ok(cls.has("tok-number"));
  assert.ok(cls.has("tok-function"));
});

test("highlight: unknown languages fall back to a single plain, uncolored token", () => {
  const tokens = highlight("<img src=x onerror=alert(1)>", "some-made-up-lang");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].cls, null);
  assert.equal(tokens[0].text, "<img src=x onerror=alert(1)>");
});

test("highlight: no language given falls back to plain text", () => {
  const tokens = highlight("const x = 1;");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].cls, null);
});

test("highlight: malformed and empty input never throws", () => {
  for (const lang of [undefined, "js", "json", "bash", "css", "html", "python", "nonsense"]) {
    assert.doesNotThrow(() => highlight("", lang));
    assert.doesNotThrow(() => highlight("` unterminated string \" ( { [ /* ", lang));
    assert.doesNotThrow(() => highlight(/** @type {any} */ (null), lang));
    assert.doesNotThrow(() => highlight(/** @type {any} */ (undefined), lang));
  }
  assert.deepEqual(highlight(""), []);
  assert.deepEqual(highlight(/** @type {any} */ (null)), []);
});

test("highlight: pathological but not huge input completes quickly (no catastrophic backtracking)", () => {
  const code = "/*" + "*".repeat(20_000) + " unterminated comment with lots of stars";
  const start = Date.now();
  highlight(code, "js");
  assert.ok(Date.now() - start < 2000);
});
