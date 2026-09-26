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

test("diff: css classes use the beacon/signal tone tokens per the design system", () => {
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

test("diff: is a pure function — same inputs, same shape of output, no shared mutable state", () => {
  const a = allText(renderDiff("x y z", "x q z"));
  const b = allText(renderDiff("x y z", "x q z"));
  assert.equal(a, b);
});
