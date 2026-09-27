// @ts-check
// Edit diffs as plain lines: from two strings (LCS, word segments on a changed pair) and from a
// unified diff's text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLineDiff, parseUnifiedDiff } from "./line-diff.js";

test("two strings: context, a changed pair with word segments, an added line", () => {
  const d = buildLineDiff("const total = 0;\nreturn total;", "const total = 10;\nreturn total;\n// Northwind");
  assert.deepEqual(d.map(l => [l.type, l.content]), [
    ["remove", "-const total = 0;"],
    ["add", "+const total = 10;"],
    ["context", " return total;"],
    ["add", "+// Northwind"],
  ]);
  assert.deepEqual(d[0].segments, [{ text: "const total = ", changed: false }, { text: "0", changed: true }, { text: ";", changed: false }]);
  assert.deepEqual(d[1].segments, [{ text: "const total = ", changed: false }, { text: "10", changed: true }, { text: ";", changed: false }]);
  assert.equal(d[3].segments, undefined);
});

test("two strings: identical, empty, null and CRLF", () => {
  assert.deepEqual(buildLineDiff("a\nb", "a\nb").map(l => l.type), ["context", "context"]);
  assert.deepEqual(buildLineDiff("", ""), []);
  assert.deepEqual(buildLineDiff(/** @type {any} */ (null), "x"), [{ type: "add", content: "+x" }]);
  assert.deepEqual(buildLineDiff("a\r\nb", "a\nb").map(l => l.type), ["context", "context"]);
  assert.deepEqual(buildLineDiff("gone", "").map(l => l.content), ["-gone"]);
});

test("two strings past the size guard: the old block out, the new block in", () => {
  const old = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");
  const d = buildLineDiff(old, "new");
  assert.equal(d.length, 2002);
  assert.ok(d.slice(0, 2001).every(l => l.type === "remove"));
  assert.deepEqual(d[2001], { type: "add", content: "+new" });
});

test("a unified diff: file headers dropped, hunks and the no-newline note kept", () => {
  const d = parseUnifiedDiff([
    "diff --git a/bakery.js b/bakery.js",
    "index 1234567..89abcde 100644",
    "--- a/bakery.js",
    "+++ b/bakery.js",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "",
    "\\ No newline at end of file",
  ].join("\n"));
  assert.deepEqual(d.map(l => [l.type, l.content]), [
    ["header", "@@ -1,3 +1,3 @@"],
    ["context", " const a = 1;"],
    ["remove", "-const b = 2;"],
    ["add", "+const b = 3;"],
    ["context", ""],
    ["header", "\\ No newline at end of file"],
  ]);
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff(undefined), []);
});

test("a unified diff: a removed '-- x' or added '++ x' inside a hunk is a line, not a file header", () => {
  const d = parseUnifiedDiff("--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old note\n+++ new note\n select 1;\n--- a/r.sql\n+++ b/r.sql\n@@ -1 +1 @@\n-x\n+y");
  assert.deepEqual(d.map(l => [l.type, l.content]), [
    ["header", "@@ -1,2 +1,2 @@"],
    ["remove", "--- old note"],
    ["add", "+++ new note"],
    ["context", " select 1;"],
    ["header", "@@ -1 +1 @@"],
    ["remove", "-x"],
    ["add", "+y"],
  ]);
});
