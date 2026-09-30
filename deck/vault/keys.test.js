// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFor, KEYMAP, HELP } from "./keys.js";

const ev = (key, extra = {}) => ({ key, target: { tagName: "BODY" }, ...extra });

test("keys: the map", () => {
  const want = { "/": "filter", j: "down", k: "up", Enter: "open", Escape: "close", c: "copy", u: "copy-username",
    t: "copy-code", e: "edit", n: "new", f: "favorite", L: "lock", "?": "help" };
  for (const [k, a] of Object.entries(want)) assert.equal(actionFor(ev(k)), a, k);
  assert.equal(actionFor(ev("l")), null, "lowercase l is not lock");
  assert.equal(actionFor(ev("x")), null);
  for (const k of Object.keys(KEYMAP).filter(k => !k.startsWith("Arrow"))) assert.ok(HELP.some(([keys]) => keys.split(/\s+/).includes(k) || (k === "Escape" && keys === "Esc")), `help lists ${k}`);
});

test("keys: inactive inside inputs and with modifiers, except Esc", () => {
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "password" }, { tagName: "input", type: "search" },
    { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    assert.equal(actionFor(ev("c", { target })), null);
    assert.equal(actionFor(ev("/", { target })), null);
    assert.equal(actionFor(ev("Escape", { target })), "close");
  }
  assert.equal(actionFor(ev("c", { target: { tagName: "INPUT", type: "checkbox" } })), "copy", "a checkbox is not typing");
  assert.equal(actionFor(ev("c", { metaKey: true })), null, "Cmd-C stays the browser's");
  assert.equal(actionFor(ev("k", { ctrlKey: true })), null);
});
