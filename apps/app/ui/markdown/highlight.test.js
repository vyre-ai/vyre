// Syntax colours for fenced code: a small tokenizer, never a parser. It must keep every character, name the usual kinds, never throw, and leave unknown languages plain.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight, familyOf } from "./highlight.js";

const flat = (/** @type {any[][]} */ ls) => ls.map((l) => l.map((t) => t.v).join("")).join("\n");
const kinds = (/** @type {any[][]} */ ls, /** @type {string} */ k) => ls.flat().filter((t) => t.k === k).map((t) => t.v);

test("highlight: strings, comments, numbers and keywords are told apart in a C-like language", () => {
  const code = 'const n = 42; // the answer\nconst s = "hi \\" there";\n/* block\n   spans */ return n;';
  const ls = highlight(code, "javascript");
  assert.equal(flat(ls), code, "every character is kept");
  assert.deepEqual(kinds(ls, "kw"), ["const", "const", "return"]);
  assert.deepEqual(kinds(ls, "num"), ["42"]);
  assert.deepEqual(kinds(ls, "str"), ['"hi \\" there"']);
  assert.deepEqual(kinds(ls, "com"), ["// the answer", "/* block", "   spans */"], "a comment that spans lines is drawn line by line");
  assert.equal(ls.length, 4);
});

test("highlight: JSON keys are not values; Python and shell comments; SQL keywords in any case; CSS properties; HTML tags", () => {
  assert.deepEqual(kinds(highlight('{"a": "b", "n": 3, "t": true}', "json"), "key"), ['"a"', '"n"', '"t"']);
  assert.deepEqual(kinds(highlight('{"a": "b", "t": true}', "json"), "str"), ['"b"']);
  assert.deepEqual(kinds(highlight("x = 1  # note\nif x:\n  pass", "python"), "com"), ["# note"]);
  assert.deepEqual(kinds(highlight("SELECT name FROM users -- who", "sql"), "kw"), ["SELECT", "FROM"]);
  assert.deepEqual(kinds(highlight("a { color: red; margin: 0 }", "css"), "key"), ["color", "margin"]);
  assert.deepEqual(kinds(highlight('<p class="x">hi</p>', "html"), "tag"), ['<p class="x">', "</p>"]);
  assert.deepEqual(kinds(highlight("npm test # run", "bash"), "kw"), ["npm"]);
});

test("highlight: an unknown language, an empty block and a huge one stay plain and keep their words; nothing throws", () => {
  assert.deepEqual(highlight("whatever 1 + 2", "klingon"), [[{ k: "plain", v: "whatever 1 + 2" }]]);
  assert.deepEqual(highlight("", "js"), [[]]);
  const big = "const a = 1;\n".repeat(5000);
  assert.equal(flat(highlight(big, "js")), big);
  assert.equal(highlight(big, "js").flat().every((t) => t.k === "plain"), true, "past the limit it is plain");
  assert.equal(flat(highlight('"unclosed string\nnext', "js")), '"unclosed string\nnext');
  assert.equal(familyOf("TSX"), "ts");
  assert.equal(familyOf(""), "");
});
