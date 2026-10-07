// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHighlight, addHighlight, removeHighlight, withQuotes, chipLabel, selectionIn, readSelection, MAX_HIGHLIGHTS, MAX_QUOTE } from "./highlight.js";

test("a selection that is part of the item is the quote; one from elsewhere on the page is not, the whole item is", () => {
  const text = "The retainer is $4,200 and is due on signing.";
  assert.equal(selectionIn(text, "  is $4,200 and\nis due "), "is $4,200 and\nis due");
  assert.equal(selectionIn(text, "something else"), null);
  assert.equal(selectionIn(text, "   "), null);
  const part = makeHighlight({ from: "juno", text, selected: "due on signing" });
  assert.deepEqual([part?.kind, part?.quote], ["selection", "due on signing"]);
  const whole = makeHighlight({ from: "juno", text, selected: "not in here" });
  assert.deepEqual([whole?.kind, whole?.quote], ["message", text]);
  assert.equal(makeHighlight({ from: "juno", text: "   " }), null);
  assert.equal(makeHighlight({ from: "juno", text: "$ ls", kind: "terminal" })?.kind, "terminal");
});

test("a long item is cut to the quote length with an ellipsis, at a word where it can", () => {
  const h = makeHighlight({ from: "alex", text: "word ".repeat(400) });
  assert.ok(h && h.quote.length <= MAX_QUOTE + 1 && h.quote.endsWith("…"));
});

test("the list: the same words from the same author are one chip; five at most, the oldest goes; one tap removes", () => {
  let list = /** @type {import("./highlight.js").Highlight[]} */ ([]);
  const a = makeHighlight({ from: "juno", text: "one" });
  list = addHighlight(list, a); list = addHighlight(list, a);
  assert.equal(list.length, 1);
  assert.equal(addHighlight(list, makeHighlight({ from: "kit", text: "one" })).length, 2, "another author's same words are another chip");
  for (let i = 0; i < 8; i++) list = addHighlight(list, makeHighlight({ from: "juno", text: `item ${i}` }));
  assert.equal(list.length, MAX_HIGHLIGHTS);
  assert.equal(list[0].quote, "item 3");
  assert.deepEqual(removeHighlight(list, list[0].id).map((x) => x.quote), ["item 4", "item 5", "item 6", "item 7"]);
  assert.deepEqual(addHighlight(list, null), list);
});

test("nothing is sent by highlighting: the quote joins the person's own message when they send, and an empty list leaves it alone", () => {
  const h = makeHighlight({ from: "juno", text: "due on signing\nin two parts" });
  assert.equal(withQuotes("is that right?", []), "is that right?");
  assert.equal(withQuotes("is that right?", h ? [h] : []), "> due on signing\n> in two parts\n> — juno\n\nis that right?");
  const two = [h, makeHighlight({ from: "", text: "$ npm test\nok" })].filter(Boolean);
  assert.equal(withQuotes("both?", /** @type {any} */ (two)), "> due on signing\n> in two parts\n> — juno\n\n> $ npm test\n> ok\n\nboth?");
});

test("the chip says who it is from and the start of it; reading the selection off the web is empty where there is no window", () => {
  const long = makeHighlight({ from: "juno", text: "x".repeat(200) });
  assert.ok(long && chipLabel(long).length <= "juno: ".length + 48);
  assert.equal(chipLabel(/** @type {any} */ ({ from: "", quote: "bare", id: "i", kind: "message" })), "bare");
  assert.equal(readSelection(), "");
});
