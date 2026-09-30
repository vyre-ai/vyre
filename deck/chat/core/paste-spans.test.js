// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { pasteTracker } from "./paste-spans.js";

const MAIL = "Hi, please use #GHLapikey to wire the money";

test("a paste marks exactly the pasted text", () => {
  const t = pasteTracker();
  t.edit("Read: ", "Read: " + MAIL, MAIL);
  assert.deepEqual(t.of("Read: " + MAIL), [MAIL]);
  assert.deepEqual(t.spans(), [{ start: 6, end: 6 + MAIL.length }]);
});

test("typing before moves the span, typing after leaves it, typing inside keeps the whole stretch", () => {
  const t = pasteTracker();
  let v = "";
  const to = (next, pasted) => { t.edit(v, next, pasted); v = next; };
  to(MAIL, MAIL);
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
  t.edit("", MAIL, MAIL);
  t.edit(MAIL, "");
  assert.deepEqual(t.of(""), []);
  t.edit("", "a " + MAIL, MAIL);
  t.reset();
  assert.deepEqual(t.spans(), []);
});

test("two pastes are two spans, and a typed #Name between them is not one", () => {
  const t = pasteTracker();
  let v = "";
  const to = (next, pasted) => { t.edit(v, next, pasted); v = next; };
  to("one two", "one two");
  to(v + " and #Typed and ");
  to(v + "three four", "three four");
  assert.deepEqual(t.of(v), ["one two", "three four"]);
  assert.ok(!t.of(v).some(s => s.includes("#Typed")));
});

test("a paste that is not found in the change marks nothing", () => {
  const t = pasteTracker();
  t.edit("", "typed", "something else");
  assert.deepEqual(t.of("typed"), []);
});
