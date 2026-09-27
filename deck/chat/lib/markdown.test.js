// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, allText, find, findAll } from "./test-dom.js";

installDom();
const { renderMarkdown } = await import("./markdown.js");

test("markdown: paragraphs split on blank lines", () => {
  const frag = renderMarkdown("First paragraph.\n\nSecond paragraph.");
  const ps = findAll(frag, "p");
  assert.equal(ps.length, 2);
  assert.equal(allText(ps[0]), "First paragraph.");
  assert.equal(allText(ps[1]), "Second paragraph.");
});

test("markdown: headings h1 through h6", () => {
  for (let n = 1; n <= 6; n++) {
    const frag = renderMarkdown(`${"#".repeat(n)} Title ${n}`);
    const h = find(frag, `h${n}`);
    assert.ok(h, `expected h${n}`);
    assert.equal(allText(h), `Title ${n}`);
  }
});

test("markdown: bold, italic, inline code", () => {
  const frag = renderMarkdown("**bold** and __also bold__, *italic* and _also italic_, and `code(1)`.");
  assert.equal(findAll(frag, "strong").map(allText).join("|"), "bold|also bold");
  assert.equal(findAll(frag, "em").map(allText).join("|"), "italic|also italic");
  assert.equal(find(frag, "code")?.textContent, "code(1)");
});

test("markdown: fenced code block becomes pre>code.lang-<lang> and tokenizes with highlight.js", () => {
  const frag = renderMarkdown("```js\nconst x = 1; // hi\n```");
  const pre = find(frag, "pre");
  const code = find(pre, "code");
  assert.equal(code.className, "lang-js");
  assert.equal(allText(code), "const x = 1; // hi");
  assert.ok(findAll(code, "span").some(s => s.className === "tok-keyword"), "expected a tok-keyword span");
});

test("markdown: fenced code block with no language still renders, uncolored", () => {
  const frag = renderMarkdown("```\nplain text\n```");
  const code = find(frag, "code");
  assert.equal(code.className, "lang-text");
  assert.equal(allText(code), "plain text");
});

test("markdown: unordered and ordered lists", () => {
  const ul = find(renderMarkdown("- one\n- two\n- three"), "ul");
  assert.equal(findAll(ul, "li").map(allText).join(","), "one,two,three");

  const ol = find(renderMarkdown("1. first\n2. second"), "ol");
  assert.equal(findAll(ol, "li").map(allText).join(","), "first,second");
});

test("markdown: nested lists nest, and pathologically deep nesting is clamped, not a stack overflow", () => {
  const frag = renderMarkdown("- top\n  - mid\n    - deep");
  const outer = find(frag, "ul");
  const inner = find(outer.children[0], "ul");
  assert.ok(inner, "expected a nested ul under the first li");

  // 2000 levels of indentation is adversarial input, not a real document. It must not hang or
  // blow the stack, it should render, clamped to a bounded depth.
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`${"  ".repeat(i)}- item ${i}`);
  const start = Date.now();
  const deep = renderMarkdown(lines.join("\n"));
  assert.ok(Date.now() - start < 2000, "deeply nested list took too long");
  assert.ok(find(deep, "ul"));
});

test("markdown: links render only for safe schemes", () => {
  const safe = renderMarkdown("[go](https://example.com/x)");
  const a = find(safe, "a");
  assert.ok(a);
  assert.equal(a.getAttribute("href"), "https://example.com/x");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");

  const relative = renderMarkdown("[go](/local/path)");
  assert.equal(find(relative, "a")?.getAttribute("href"), "/local/path");

  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.example.com/x"]) {
    const frag = renderMarkdown(`[click me](${url})`);
    assert.equal(find(frag, "a"), null, `expected no <a> for ${url}`);
    assert.ok(allText(frag).includes("click me"), "link text should still appear, as plain text");
  }
});

test("markdown: blockquotes", () => {
  const frag = renderMarkdown("> a wise remark\n> continued");
  const bq = find(frag, "blockquote");
  assert.ok(bq);
  assert.equal(allText(bq), "a wise remark continued");
});

test("markdown: raw HTML in the input is never parsed as markup, it is text, or nothing", () => {
  const payload = '<img src=x onerror=alert(1)> and <script>alert(1)</script> and <b>bold via html</b>';
  const frag = renderMarkdown(payload);
  assert.equal(find(frag, "img"), null);
  assert.equal(find(frag, "script"), null);
  assert.equal(find(frag, "b"), null);
  assert.ok(allText(frag).includes("<img src=x onerror=alert(1)>"), "the tag text should survive literally");
  assert.ok(allText(frag).includes("<script>alert(1)</script>"));
});

test("markdown: a fake heading spanning the input can't take over more than its own line", () => {
  const frag = renderMarkdown(`# ${"x".repeat(1000)}\n\nreal paragraph`);
  const h1s = findAll(frag, "h1");
  assert.equal(h1s.length, 1);
  assert.ok(find(frag, "p"), "the following paragraph must still render as a paragraph, not be swallowed");
});

test("markdown: a fenced code block containing an XSS-shaped payload renders as inert text", () => {
  const frag = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
  assert.equal(find(frag, "img"), null);
  const code = find(frag, "code");
  assert.ok(allText(code).includes("<img src=x onerror=alert(1)>"));
});

test("markdown: huge input is truncated with a visible note, and doesn't hang", () => {
  const huge = "word ".repeat(20_000); // 100,000 chars, well past the 50,000 cap
  const start = Date.now();
  const frag = renderMarkdown(huge);
  assert.ok(Date.now() - start < 3000, "rendering huge input took too long");
  assert.ok(findAll(frag, "p").some(p => p.className === "md-truncated"), "expected a visible truncation note");
});

test("markdown: empty and non-string input never throws", () => {
  assert.doesNotThrow(() => renderMarkdown(""));
  assert.doesNotThrow(() => renderMarkdown(/** @type {any} */ (null)));
  assert.doesNotThrow(() => renderMarkdown(/** @type {any} */ (undefined)));
});
