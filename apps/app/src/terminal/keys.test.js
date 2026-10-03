import { test } from "node:test";
import assert from "node:assert/strict";
import { ROW, ctrl, key, press, applyCtrl } from "./keys.js";

test("keys: the row is esc, tab, ctrl, four arrows, pipe, slash", () => {
  assert.deepEqual(ROW.map((k) => k.id), ["esc", "tab", "ctrl", "left", "up", "down", "right", "pipe", "slash"]);
  assert.equal(ROW.find((k) => k.id === "ctrl").sticky, true);
});

test("keys: esc, tab, pipe, slash", () => {
  assert.equal(key("esc"), "\x1b");
  assert.equal(key("tab"), "\t");
  assert.equal(key("pipe"), "|");
  assert.equal(key("slash"), "/");
  assert.equal(key("ctrl"), "");
  assert.equal(key("nope"), "");
});

test("keys: arrows are CSI normally and SS3 in application-cursor mode", () => {
  assert.equal(key("up"), "\x1b[A");
  assert.equal(key("down"), "\x1b[B");
  assert.equal(key("right"), "\x1b[C");
  assert.equal(key("left"), "\x1b[D");
  assert.equal(key("up", { appCursor: true }), "\x1bOA");
  assert.equal(key("left", { appCursor: true }), "\x1bOD");
  assert.equal(key("down", { appCursor: false }), "\x1b[B");
});

test("keys: ctrl+<c> is the control byte", () => {
  assert.equal(ctrl("c"), "\x03");
  assert.equal(ctrl("C"), "\x03");
  assert.equal(ctrl("a"), "\x01");
  assert.equal(ctrl("d"), "\x04");
  assert.equal(ctrl("z"), "\x1a");
  assert.equal(ctrl("["), "\x1b");
  assert.equal(ctrl("\\"), "\x1c");
  assert.equal(ctrl(" "), "\x00");
  assert.equal(ctrl("?"), "\x7f");
  assert.equal(ctrl("1"), null);
  assert.equal(ctrl("ab"), null);
  assert.equal(ctrl(""), null);
});

test("keys: ctrl is sticky for one key, then lets go; a second press disarms it", () => {
  let s = { ctrl: false };
  let r = press(s, "ctrl");
  assert.deepEqual(r, { state: { ctrl: true }, send: "" });
  r = applyCtrl(r.state, "c");
  assert.deepEqual(r, { state: { ctrl: false }, send: "\x03" });
  r = applyCtrl(r.state, "c");
  assert.deepEqual(r, { state: { ctrl: false }, send: "c" });
  r = press(press(s, "ctrl").state, "ctrl");
  assert.equal(r.state.ctrl, false);
  // An accessory key pressed while armed is sent as it is and ctrl lets go.
  r = press({ ctrl: true }, "up", { appCursor: true });
  assert.deepEqual(r, { state: { ctrl: false }, send: "\x1bOA" });
  assert.deepEqual(press({ ctrl: false }, "pipe"), { state: { ctrl: false }, send: "|" });
});

test("keys: a key with no control form passes through when ctrl is armed", () => {
  assert.deepEqual(applyCtrl({ ctrl: true }, "1x"), { state: { ctrl: false }, send: "1x" });
  assert.deepEqual(applyCtrl({ ctrl: true }, "cat"), { state: { ctrl: false }, send: "\x03at" });
});
