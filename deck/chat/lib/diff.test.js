// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, allText, findAll } from "./test-dom.js";

installDom();
const { renderDiff } = await import("./diff.js");

test("diff: identical strings produce no del/ins, just the text", () => {
  const node = renderDiff("same text here", "same text here");
  assert.equal(findAll(node, "del").length, 0);
  assert.equal(findAll(node, "ins").length, 0);
  assert.equal(allText(node), "same text here");
});

test("diff: a pure addition has only ins", () => {
  const node = renderDiff("hello", "hello world");
  assert.equal(findAll(node, "del").length, 0);
  const ins = findAll(node, "ins");
  assert.equal(ins.length, 1);
  assert.ok(allText(ins[0]).includes("world"));
  assert.equal(allText(node), "hello world");
});

test("diff: a pure removal has only del", () => {
  const node = renderDiff("hello world", "hello");
  const del = findAll(node, "del");
  assert.equal(del.length, 1);
  assert.ok(allText(del[0]).includes("world"));
  assert.equal(findAll(node, "ins").length, 0);
});

test("diff: word-level substitution shows both a del and an ins, not a whole-line rewrite", () => {
  const node = renderDiff("the quick brown fox", "the slow brown fox");
  assert.equal(findAll(node, "del").length, 1);
  assert.equal(findAll(node, "ins").length, 1);
  assert.ok(allText(findAll(node, "del")[0]).includes("quick"));
  assert.ok(allText(findAll(node, "ins")[0]).includes("slow"));
  // the untouched words are not wrapped at all
  assert.ok(allText(node).includes("the"));
  assert.ok(allText(node).includes("brown fox"));
});

test("diff: every removed run comes from `before` and every added run comes from `after`", () => {
  const before = "one two three four";
  const after = "one two-and-a-half three four five";
  const node = renderDiff(before, after);
  for (const d of findAll(node, "del")) assert.ok(before.includes(allText(d).trim()), `"${allText(d)}" not in before`);
  for (const i of findAll(node, "ins")) assert.ok(after.includes(allText(i).trim()), `"${allText(i)}" not in after`);
});

test("diff: the word diff marks runs with the del/ins classes (neutral del wash, signal wash)", () => {
  const node = renderDiff("a b", "a c");
  const del = findAll(node, "del")[0];
  const ins = findAll(node, "ins")[0];
  assert.equal(del.className, "diff-del");
  assert.equal(ins.className, "diff-ins");
});

test("diff: empty strings, null/undefined, and huge inputs never throw and stay fast", () => {
  assert.doesNotThrow(() => renderDiff("", ""));
  assert.doesNotThrow(() => renderDiff(/** @type {any} */ (null), /** @type {any} */ (undefined)));
  const big = "word ".repeat(20_000);
  const start = Date.now();
  assert.doesNotThrow(() => renderDiff(big, big + "extra"));
  assert.ok(Date.now() - start < 3000, "huge diff took too long");
});

test("diff: is a pure function, same inputs, same shape of output, no shared mutable state", () => {
  const a = allText(renderDiff("x y z", "x q z"));
  const b = allText(renderDiff("x y z", "x q z"));
  assert.equal(a, b);
});

test("lineDiff: unified rows, removed before added, equal lines kept", async () => {
  const { lineDiff } = await import("./diff.js");
  const rows = lineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(rows.map(r => r.type + r.text), [" a", "-b", "+B", " c", "+d"]);
  assert.deepEqual(lineDiff("", "x").map(r => r.type + r.text), ["+x"]);
  assert.deepEqual(lineDiff("x", "").map(r => r.type + r.text), ["-x"]);
  assert.deepEqual(lineDiff("same", "same").map(r => r.type), [" "]);
});

// ---- the unified line diff as DOM (diff.md, inline variant) ----

const cls = (node, c, out = []) => { for (const k of node.childNodes || []) { if (k.nodeType === 1 && k.className.split(" ").includes(c)) out.push(k); cls(k, c, out); } return out; };
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("renderRows: a table of rows, three cells each, number and sign hidden from readers, text a cell", async () => {
  const { renderUnified } = await import("./diff.js");
  const el = renderUnified("a\nb", "a\nc", { oldStart: 11, newStart: 11 });
  assert.equal(el.className, "cv-diff");
  const table = cls(el, "cv-diff-rows")[0];
  assert.equal(table.getAttribute("role"), "table");
  const rows = cls(el, "cv-dl");
  assert.deepEqual(rows.map(r => r.className), ["cv-dl", "cv-dl cv-dl-del", "cv-dl cv-dl-add"]);
  for (const r of rows) {
    assert.equal(r.getAttribute("role"), "row");
    const [n, g, t] = r.children;
    assert.deepEqual([n.className, g.className, t.className], ["cv-dl-n", "cv-dl-g", "cv-dl-t"]);
    assert.equal(n.getAttribute("aria-hidden"), "true");
    assert.equal(g.getAttribute("aria-hidden"), "true");
    assert.equal(t.getAttribute("role"), "cell");
  }
  assert.deepEqual(rows.map(r => allText(r.children[1])), ["", "-", "+"]);
  assert.equal(rows[1].getAttribute("aria-label"), "removed line 12, b");
  assert.equal(rows[2].getAttribute("aria-label"), "added line 12, c");
  assert.equal(rows[0].getAttribute("aria-label"), "unchanged line 11, a");
  assert.equal(cls(el, "cv-diff-more").length, 0, "a short diff has no Show all");
});

test("renderRows: a hunk header row has empty number and sign and its text", async () => {
  const { renderRows, patchRows } = await import("./diff.js");
  const el = renderRows(patchRows([{ oldStart: 4, newStart: 4, lines: [" keep", "-old", "+new"] }]));
  const rows = cls(el, "cv-dl");
  assert.equal(rows[0].className, "cv-dl cv-dl-hunk");
  assert.equal(allText(rows[0]), "@@ -4 +4 @@");
  assert.deepEqual(rows.slice(1).map(r => allText(r.children[0])), ["4", "5", "5"]);
});

test("renderRows: capped at 20 lines, then a ghost Show all button with the real count; a tap draws the rest", async () => {
  const { renderUnified, INLINE_CAP } = await import("./diff.js");
  assert.equal(INLINE_CAP, 20);
  const el = renderUnified(lines(30), lines(34)); // 30 unchanged, 4 added: 34 lines
  assert.equal(cls(el, "cv-dl").length, 20);
  const more = cls(el, "cv-diff-more")[0];
  assert.ok(more, "the Show all button");
  assert.equal(more.tagName, "BUTTON");
  assert.equal(more.getAttribute("type"), "button");
  assert.match(more.className, /\bbtn-ghost\b/);
  assert.equal(allText(more), "Show all 34 lines");
  more.listeners.click[0]();
  assert.equal(cls(el, "cv-dl").length, 34);
  assert.equal(cls(el, "cv-dl-add").length, 4);
  assert.equal(cls(el, "cv-diff-more").length, 0, "the button goes once everything shows");
  // 20 exactly fits; 21 does not
  assert.equal(cls(renderUnified("", lines(20)), "cv-diff-more").length, 0);
  assert.equal(allText(cls(renderUnified("", lines(21)), "cv-diff-more")[0]), "Show all 21 lines");
  // cap 0 draws everything; large counts get a thousands comma
  assert.equal(cls(renderUnified("", lines(64), {}, { cap: 0 }), "cv-dl").length, 64);
  assert.equal(allText(cls(renderUnified("", lines(4200)), "cv-diff-more")[0]), "Show all 4,200 lines");
});

test("renderRows: hunk headers are not counted against the cap or in the Show all count", async () => {
  const { renderRows, patchRows } = await import("./diff.js");
  const hunk = (at, n) => ({ oldStart: at, newStart: at, lines: Array.from({ length: n }, (_, i) => ` l${i}`) });
  const el = renderRows(patchRows([hunk(3, 15), hunk(40, 15)]));
  const rows = cls(el, "cv-dl");
  assert.equal(rows.filter(r => !r.className.includes("cv-dl-hunk")).length, 20);
  assert.equal(allText(cls(el, "cv-diff-more")[0]), "Show all 30 lines");
});

test("counts: added and removed from rows, printed with the true minus sign", async () => {
  const { rowCounts, countsLabel, lineDiff, MINUS } = await import("./diff.js");
  assert.equal(MINUS, "\u2212");
  const c = rowCounts(lineDiff("a\nb\nc\nd", "a\nB\nc"));
  assert.deepEqual(c, { added: 1, removed: 2 });
  assert.equal(countsLabel(c), "+1 \u22122");
  assert.equal(countsLabel({ added: 60, removed: 0 }), "+60");
  assert.equal(countsLabel({ added: 0, removed: 3 }), "\u22123");
  assert.equal(countsLabel({ added: 0, removed: 0 }), "+0");
  assert.ok(!countsLabel({ added: 12, removed: 4 }).includes("-"), "never the hyphen");
});
