// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signature, diff, verdict } from "./verify.js";

const snap = (elements, extra = {}) => ({ app: "Calculator", window: "Calculator", elements, texts: [], ...extra });
const key = { path: "/0/1", role: "AXButton", name: "7", enabled: true };
const doc = { path: "/0/0/0", role: "AXTextArea", name: "text entry area", value: "" };
const sel = { role: "AXTextArea", name: "text entry area" };

test("verify: frames do not count, so a window reflowing is not an effect", () => {
  assert.equal(signature(snap([{ ...key, frame: { x: 1, y: 1, w: 9, h: 9 } }])), signature(snap([{ ...key, frame: { x: 2, y: 5, w: 9, h: 9 } }])));
});

test("verify: a press is verified only when the window changed", () => {
  const before = snap([key], { texts: ["0"] });
  assert.equal(verdict({ kind: "press", selector: { role: "AXButton", name: "7" }, before, after: snap([key], { texts: ["7"] }) }).verified, true);
  const same = verdict({ kind: "press", selector: { role: "AXButton", name: "7" }, before, after: snap([key], { texts: ["0"] }) });
  assert.equal(same.verified, false);
  assert.match(same.reason, /did not land/);
});

test("verify: set checks the value on the control found again", () => {
  const before = snap([doc]);
  assert.equal(verdict({ kind: "set", value: "Northwind Bakery", selector: sel, before, after: snap([{ ...doc, value: "Northwind Bakery" }]) }).verified, true);
  assert.equal(verdict({ kind: "set", value: "Northwind Bakery", selector: sel, before, after: snap([{ ...doc, value: "Northwind" }]) }).verified, false);
});

test("verify: typed text must appear more times than it did before", () => {
  const before = snap([{ ...doc, value: "hello" }]);
  assert.equal(verdict({ kind: "type", value: "hello", selector: sel, before, after: snap([{ ...doc, value: "hello" }]) }).verified, false);
  assert.equal(verdict({ kind: "type", value: "hello", selector: sel, before, after: snap([{ ...doc, value: "hellohello" }]) }).verified, true);
});

test("verify: a secure field is never claimed as verified", () => {
  const pw = { path: "/0/3", role: "AXTextField", name: "Password", secure: true };
  const r = verdict({ kind: "type", value: "x", selector: { role: "AXTextField", name: "Password" }, before: snap([pw]), after: snap([pw]) });
  assert.equal(r.verified, false);
  assert.match(r.reason, /secure/);
});

test("verify: a control that vanished cannot confirm a set", () => {
  const r = verdict({ kind: "set", value: "x", selector: sel, before: snap([doc]), after: snap([]) });
  assert.equal(r.verified, false);
  assert.match(r.reason, /could not be found again/);
});

test("verify: focus is read from the control itself", () => {
  assert.equal(verdict({ kind: "focus", selector: sel, before: snap([doc]), after: snap([{ ...doc, focused: true }]) }).verified, true);
  assert.equal(verdict({ kind: "focus", selector: sel, before: snap([doc]), after: snap([doc]) }).verified, false);
});

test("verify: the diff names what moved and never repeats a value", () => {
  const d = diff(snap([doc]), snap([{ ...doc, value: "a secret" }, key], { window: "Untitled 2" }));
  assert.deepEqual(d.altered, ["text entry area"]);
  assert.deepEqual(d.appeared, ["7"]);
  assert.equal(d.title?.to, "Untitled 2");
  assert.ok(!JSON.stringify(d).includes("a secret"));
});

test("verify: each accessibility action has its own rule, and says so when it cannot see an effect", () => {
  const step = { path: "/0/4", role: "AXIncrementor", name: "Copies", value: "2" };
  const s = { role: "AXIncrementor", name: "Copies" };
  const v = (/** @type {string} */ action, /** @type {any} */ before, /** @type {any} */ after, sel = s) => verdict({ kind: "action", action, selector: sel, before, after });
  assert.equal(v("AXIncrement", snap([step]), snap([{ ...step, value: "3" }])).verified, true);
  assert.equal(v("AXIncrement", snap([step]), snap([{ ...step, value: "1" }])).verified, false);
  assert.equal(v("AXDecrement", snap([step]), snap([{ ...step, value: "1" }])).verified, true);
  assert.match(v("AXIncrement", snap([step]), snap([step])).reason, /at its limit/);
  assert.match(v("AXIncrement", snap([{ ...step, value: undefined }]), snap([{ ...step, value: undefined }])).reason, /numeric value/);

  const field = { path: "/0/0", role: "AXTextField", name: "Name" };
  const f = { role: "AXTextField", name: "Name" };
  const menu = { path: "/1/0", role: "AXMenuItem", name: "Copy" };
  assert.equal(v("AXShowMenu", snap([field]), snap([field, menu]), f).verified, true);
  const noMenu = v("AXShowMenu", snap([field]), snap([field], { texts: ["moved"] }), f);
  assert.equal(noMenu.verified, false, "a window change was credited as a menu");
  assert.match(noMenu.reason, /no menu appeared/);

  const win = { path: "/0", role: "AXWindow", name: "Harlow Legal" };
  const w = { role: "AXWindow", name: "Harlow Legal" };
  assert.equal(v("AXRaise", snap([win]), snap([{ ...win, focused: true }]), w).verified, true);
  assert.equal(v("AXRaise", snap([win]), snap([win]), w).verified, false);

  const row = { ...field, frame: { x: 0, y: 900, w: 10, h: 10 } };
  assert.equal(v("AXScrollToVisible", snap([row]), snap([{ ...row, frame: { x: 0, y: 300, w: 10, h: 10 } }]), f).verified, true);
  const still = v("AXScrollToVisible", snap([row]), snap([row]), f);
  assert.equal(still.verified, false);
  assert.match(still.reason, /already have been in view/);

  for (const a of ["AXConfirm", "AXPick", "AXCancel"]) {
    assert.equal(v(a, snap([field]), snap([field], { texts: ["done"] }), f).verified, true, a);
    assert.equal(v(a, snap([field]), snap([field]), f).verified, false, a);
  }
});
