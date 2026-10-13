import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { messageKey, stepMessage } from "./message-keys.js";

test("messageKey maps one letter to one action", () => {
  assert.equal(messageKey({ key: "r" }, { mine: false }), "reply");
  assert.equal(messageKey({ key: "c" }, { mine: false }), "copy");
  assert.equal(messageKey({ key: "C", shiftKey: true }, { mine: false }), "copy-md");
  assert.equal(messageKey({ key: "a" }, { mine: false }), "ask");
  assert.equal(messageKey({ key: "e" }, { mine: true }), "edit");
  assert.equal(messageKey({ key: "e" }, { mine: false }), null);
  assert.equal(messageKey({ key: "ArrowUp" }, { mine: false }), "up");
  assert.equal(messageKey({ key: "Escape" }, { mine: false }), "leave");
});

test("messageKey leaves chords and other keys alone", () => {
  assert.equal(messageKey({ key: "c", metaKey: true }, { mine: false }), null);
  assert.equal(messageKey({ key: "x" }, { mine: false }), null);
  assert.equal(messageKey({ key: "R", shiftKey: true }, { mine: false }), null);
});

test("stepMessage moves one message and stops at the ends", () => {
  assert.equal(stepMessage(-1, 5, "up"), 4);
  assert.equal(stepMessage(-1, 5, "down"), 0);
  assert.equal(stepMessage(2, 5, "up"), 1);
  assert.equal(stepMessage(0, 5, "up"), 0);
  assert.equal(stepMessage(4, 5, "down"), 4);
  assert.equal(stepMessage(0, 0, "down"), -1);
});
