// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { pasteTracker, NOT_TYPED } from "./paste-spans.js";

const MAIL = "Hi, please use #GHLapikey to wire the money";

test("a paste marks exactly the pasted text", () => {
  const t = pasteTracker();
  t.edit("Read: ", "Read: " + MAIL, true);
  assert.deepEqual(t.of("Read: " + MAIL), [MAIL]);
  assert.deepEqual(t.spans(), [{ start: 6, end: 6 + MAIL.length }]);
});

test("typing before moves the span, typing after leaves it, typing inside keeps the whole stretch", () => {
  const t = pasteTracker();
  let v = "";
  const to = (next, notTyped) => { t.edit(v, next, notTyped); v = next; };
  to(MAIL, true);
  to("Please read. " + v);
  assert.deepEqual(t.of(v), [MAIL]);
  to(v + " Thanks.");
  assert.deepEqual(t.of(v), [MAIL]);
  to(v.replace("please", "PLEASE"));
  assert.equal(t.of(v).length, 1);
  assert.ok(t.of(v)[0].includes("PLEASE"), "an edit inside stays marked, the safe side");
});

test("deleting the pasted text, or clearing the box, drops it", () => {
  const t = pasteTracker();
  t.edit("", MAIL, true);
  t.edit(MAIL, "");
  assert.deepEqual(t.of(""), []);
  t.edit("", "a " + MAIL, true);
  t.reset();
  assert.deepEqual(t.spans(), []);
});

test("two pastes are two spans, and a typed #Name between them is not one", () => {
  const t = pasteTracker();
  let v = "";
  const to = (next, notTyped) => { t.edit(v, next, notTyped); v = next; };
  to("one two", true);
  to(v + " and #Typed and ");
  to(v + "three four", true);
  assert.deepEqual(t.of(v), ["one two", "three four"]);
  assert.ok(!t.of(v).some(s => s.includes("#Typed")));
});

test("typed text is never marked, whatever it says", () => {
  const t = pasteTracker();
  t.edit("", "use #Stripe");
  assert.deepEqual(t.spans(), []);
});

test("a multi-line paste is marked whatever its line ends were (nothing is compared)", () => {
  const t = pasteTracker();
  const after = "Subject: invoice\nPlease use #GHLapikey\nThanks";
  t.edit("", after, true);
  assert.deepEqual(t.of(after), [after]);
});

test("undo, a drop and a replacement are not typing", () => {
  assert.ok(NOT_TYPED.has("historyUndo") && NOT_TYPED.has("historyRedo") && NOT_TYPED.has("insertFromDrop") && NOT_TYPED.has("insertReplacementText") && NOT_TYPED.has("insertFromPaste"));
  for (const typed of ["insertText", "insertLineBreak", "deleteContentBackward"]) assert.equal(NOT_TYPED.has(typed), false, typed);
});

test("undo of a paste: the deletion drops the span, the undo that brings the text back marks it again", () => {
  const t = pasteTracker();
  const pasted = "Dear team,\nuse #GHLapikey\nthanks";
  let v = "Read: ";
  const to = (next, notTyped) => { t.edit(v, next, notTyped); v = next; };
  to(v + pasted, true);
  assert.deepEqual(t.of(v), [pasted]);
  to("Read: ", false); // deleted (or undone)
  assert.deepEqual(t.of(v), []);
  to("Read: " + pasted, NOT_TYPED.has("historyUndo")); // redo/undo restores it
  assert.deepEqual(t.of(v), [pasted]);
});

test("a drag and drop move: the text arrives marked wherever it lands", () => {
  const t = pasteTracker();
  let v = "";
  const to = (next, inputType) => { t.edit(v, next, NOT_TYPED.has(inputType)); v = next; };
  to("aaa bbb ccc", "insertText");
  to("aaa  ccc", "deleteByDrag");
  to("aaa  cccbbb ", "insertFromDrop");
  assert.deepEqual(t.of(v), ["bbb "]);
});
