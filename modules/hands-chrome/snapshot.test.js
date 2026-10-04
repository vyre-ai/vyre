import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPRESSION, toSnapshot } from "./snapshot.js";
import { of } from "./consequence.js";

test("the page snapshot carries the native facts the click guard believes: submit and href", () => {
  assert.match(EXPRESSION, /c\.submit = true/);
  assert.match(EXPRESSION, /c\.href = String\(el\.href\)/);
  assert.match(EXPRESSION, /ty === "submit"/);
});
test("toSnapshot keeps them, and the guard acts on them whatever the control is called", () => {
  const snap = toSnapshot({ title: "t", url: "https://x.test/", controls: [{ path: "a", role: "button", name: "Next", enabled: true, submit: true }, { path: "b", role: "link", name: "More", enabled: true, href: "https://x.test/oauth/authorize?c=1" }] });
  assert.equal(snap.controls[0].submit, true);
  assert.equal(of(snap.controls[0]).consequential, true);
  assert.equal(of(snap.controls[1]).consequential, true);
});
