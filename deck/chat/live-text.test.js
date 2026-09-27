// @ts-check
// A streaming reply (live-text.js): block ends are found once per line (linear, even inside a
// long open fence), finished blocks are frozen (the same elements across frames), an open code
// block is plain text and is highlighted once it closes, and done renders the whole reply once.
// The fake DOM; sample text only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");

const { textItemRow, settledEnd, scan, newScan } = await import("./live-text.js");
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));
/** Past the pacer's lag bound (250 ms), everything that arrived is shown. */
const SHOWN_MS = 400;

test("settledEnd: after a blank line or a closing fence, never inside an open fence", () => {
  assert.equal(settledEnd(""), 0);
  assert.equal(settledEnd("One line, still being written"), 0);
  assert.equal(settledEnd("First.\n\nSecond"), 8);
  assert.equal(settledEnd("First.\n\n```js\nconst a = 1;\n\nconst b = 2;\n"), 8, "the blank line inside the fence does not count");
  const closed = "First.\n\n```js\nconst a = 1;\n```\nAfter";
  assert.equal(settledEnd(closed), closed.indexOf("After"), "a closing fence ends a block");
});

test("settledEnd is linear inside a long open fence", () => {
  const s = "Intro for Northwind Bakery.\n\n```\n" + "line\n\n".repeat(40_000);
  const t = performance.now();
  assert.equal(settledEnd(s), "Intro for Northwind Bakery.\n\n".length);
  const ms = performance.now() - t;
  assert.ok(ms < 250, `took ${Math.round(ms)} ms`);
});

test("scan fed in pieces agrees with one pass over each prefix", () => {
  const sample = "Harlow Legal intake.\n\n- one\n- two\n\n```py\nx = 1\n\n\ny = 2\n```\nThen text.\n\n~~~\nnot a fence here\n\nEnd.";
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 50; round++) {
    const st = newScan();
    for (let n = 0; n < sample.length;) {
      n = Math.min(sample.length, n + 1 + Math.floor(rnd() * 9));
      const prefix = sample.slice(0, n);
      scan(st, prefix);
      assert.equal(st.end, settledEnd(prefix), `round ${round} at ${n}`);
    }
  }
});

test("finished blocks are frozen, an open fence is plain text, a closed one is highlighted once, done renders whole", async () => {
  const row = /** @type {any} */ (textItemRow(Date.now(), { visible: () => true }));
  row.sync({ text: "Reading the Harlow Legal intake.\n\nNext", streaming: true });
  await wait(SHOWN_MS);
  const top = row.children[0];
  assert.ok(top, "the frozen part");
  const first = top.children[0];
  assert.match(text(first), /Reading the Harlow Legal intake\./);

  const open = "Reading the Harlow Legal intake.\n\nNext, the form.\n\n```js\nconst a = 1;\n\nconst b = 2;\n";
  row.sync({ text: open, streaming: true });
  await wait(SHOWN_MS);
  assert.equal(row.children[0], top, "the same frozen part");
  assert.equal(top.children[0], first, "a finished block is not rendered again");
  const pre = $(row, ".cv-open-fence");
  assert.ok(pre, "the open fence");
  const code = pre.children[0];
  assert.match(text(code), /const b = 2;/);
  assert.deepEqual(code.children.map(c => c.className), ["msg-cursor"], "plain text while open: no highlight spans");

  row.sync({ text: open + "```\nThe form is fine", streaming: true });
  await wait(SHOWN_MS);
  assert.equal($(row, ".cv-open-fence"), null, "closed");
  assert.equal(top.children[0], first, "still the same first block");
  const closed = top.children.find(c => c.tagName === "PRE");
  assert.ok(closed, "the closed block is frozen");
  assert.ok(closed.children[0].children.length > 0, "and highlighted");
  assert.match(text(row), /The form is fine/);

  row.sync({ text: open + "```\nThe form is fine.", streaming: false });
  assert.equal($(row, ".cv-md-part"), null, "done: one whole render");
  assert.equal($(row, ".msg-cursor"), null);
  assert.match(text(row), /The form is fine\./);
  row.stop();
});

test("text that is not the same text grown starts again", async () => {
  const row = /** @type {any} */ (textItemRow(Date.now(), { visible: () => true }));
  row.sync({ text: "Kit wrote this.\n\nAnd", streaming: true });
  await wait(SHOWN_MS);
  row.sync({ text: "Juno wrote this instead.\n\nAnd more", streaming: true });
  await wait(SHOWN_MS);
  assert.doesNotMatch(text(row), /Kit wrote this/);
  assert.match(text(row), /Juno wrote this instead\./);
  row.stop();
});
