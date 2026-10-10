// Chat markdown, a closed set: every mark renders as its own node, HTML is only words, a link opens only if it is safe, and half-written input (a reply streaming in) never throws and never loses words.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, inline, safeHref, plainOf } from "./parse.js";

const kinds = (/** @type {any[]} */ ns) => ns.map((n) => n.t);

test("markdown: each block mark in the closed set is its own node", () => {
  const md = [
    "# Title", "", "A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).", "",
    "- one", "- two", "  - nested", "", "1. first", "2. second", "",
    "> quoted words", "", "---", "", "| Name | Count |", "|:--|--:|", "| Alex | 3 |", "| Sam | 14 |", "", "```js", "const a = 1;", "```",
  ].join("\n");
  const b = parse(md);
  assert.deepEqual(kinds(b), ["h", "p", "list", "list", "quote", "rule", "table", "code"]);
  assert.deepEqual([b[0].level, plainOf(b[0].c)], [1, "Title"]);
  assert.deepEqual(kinds(b[1].c), ["text", "b", "text", "i", "text", "code", "text", "a", "text"]);
  assert.equal(b[1].c[7].href, "https://example.com");
  assert.deepEqual([b[2].ordered, b[2].items.length, kinds(b[2].items[1])], [false, 2, ["p", "list"]], "a bullet holds a nested list");
  assert.deepEqual([b[3].ordered, b[3].start, b[3].items.length], [true, 1, 2]);
  assert.deepEqual(kinds(b[4].c), ["p"]);
  assert.deepEqual([b[6].head.map(plainOf), b[6].rows.map((r) => r.map(plainOf)), b[6].align], [["Name", "Count"], [["Alex", "3"], ["Sam", "14"]], ["left", "right"]]);
  assert.deepEqual([b[7].lang, b[7].text, b[7].open], ["js", "const a = 1;", false]);
});

test("markdown: HTML is words, never markup: a script or a tag is shown as text", () => {
  const b = parse("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>bold?</b>**");
  assert.deepEqual(kinds(b), ["p", "p", "p"]);
  assert.equal(plainOf(b[0].c), "<script>alert(1)</script>");
  assert.equal(plainOf(b[1].c), "<img src=x onerror=alert(1)>");
  assert.equal(plainOf(b[2].c), "<b>bold?</b>");
  assert.ok(!JSON.stringify(b).includes('"t":"html"'), "there is no html node");
});

test("markdown: a link opens only when it is http, https or mailto; any other target is just its words", () => {
  assert.equal(safeHref("https://a.example"), true);
  assert.equal(safeHref("mailto:a@b.example"), true);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.example", "/relative"]) assert.equal(safeHref(bad), false, bad);
  const n = inline("[click](javascript:alert(1)) and [ok](https://a.example)");
  assert.deepEqual(kinds(n).filter((k) => k === "a"), ["a"], "only the safe one is a link");
  assert.equal(plainOf(n), "click and ok", "the unsafe one keeps its label");
  assert.equal(inline("see https://a.example/x, ok")[1].href, "https://a.example/x", "a bare address is a link, without the comma");
  assert.equal(inline("<https://a.example>")[0].href, "https://a.example");
});

test("markdown: a reply that is still arriving never throws and never loses its words", () => {
  const whole = "Here is **bold and `code` and *it* and a [lin";
  for (let n = 0; n <= whole.length; n++) { const t = whole.slice(0, n); assert.doesNotThrow(() => parse(t)); }
  const open = parse("Run this:\n\n```bash\nnpm test\nnpm run");
  assert.deepEqual([open[1].t, open[1].lang, open[1].text, open[1].open], ["code", "bash", "npm test\nnpm run", true], "an unclosed fence is a code block that is still open");
  assert.equal(plainOf(parse("an **unclosed mark")[0].c), "an **unclosed mark", "an unclosed mark is its own characters");
  assert.equal(plainOf(parse("snake_case_name and 2 * 3 * 4")[0].c), "snake_case_name and 2 * 3 * 4", "underscores inside words and spaced stars are not emphasis");
});

test("markdown: lists, headings and paragraphs the way models write them", () => {
  const b = parse("Steps:\n- one\n- two\n\nThen:\n\n1. a\n   - b\n   - c\n2. d\n\n## Done\nthe end");
  assert.deepEqual(kinds(b), ["p", "list", "p", "list", "h", "p"], "a list may follow a line with no blank between");
  assert.deepEqual(b[3].items.map((it) => kinds(it)), [["p", "list"], ["p"]]);
  assert.deepEqual(b[3].items[0][1].items.length, 2);
  assert.equal(plainOf(b[5].c), "the end");
  assert.deepEqual(kinds(parse("* * *")), ["rule"]);
  assert.equal(plainOf(parse("line one\nline two")[0].c), "line one line two", "a soft break is a space");
  assert.deepEqual(kinds(parse("a  \nb")[0].c), ["text", "br", "text"], "two spaces make a break");
  assert.equal(plainOf(parse("a \\* b")[0].c), "a * b", "an escaped mark is the mark");
});

test("markdown: a table needs its separator row, and a pipe in a paragraph is not a table", () => {
  assert.deepEqual(kinds(parse("a | b\nnot a separator")), ["p"]);
  assert.deepEqual(kinds(parse("| a | b |\n| - | - |\n| 1 | 2 |")), ["table"]);
  assert.equal(parse("| a | b |\n|---|---|\n| 1 \\| 2 | 3 |")[0].rows[0][0].map((n) => n.v).join(""), "1 | 2");
});
