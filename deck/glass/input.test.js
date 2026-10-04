// @ts-check
// The take-over input rules that do not need a browser: keysyms for typed text and the paste cap.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { keysymFor, capBytes, PASTE_CAP } from "./input.js";

test("glass input: Latin-1 as itself, the rest as 0x1000000 + code point", () => {
  assert.equal(keysymFor("a"), 0x61);
  assert.equal(keysymFor("é"), 0xe9);
  assert.equal(keysymFor("€"), 0x1000000 + 0x20ac);
  assert.equal(keysymFor("😀"), 0x1000000 + 0x1f600);
  assert.equal(keysymFor("\n"), 0xff0d);
  assert.equal(keysymFor("\t"), 0xff09);
  assert.equal(keysymFor("\u0007"), 0);
});

test("glass input: a paste is cut at 4 KB on a character boundary", () => {
  assert.equal(capBytes("hello"), "hello");
  const long = "é".repeat(PASTE_CAP);
  const cut = capBytes(long);
  assert.ok(new TextEncoder().encode(cut).length <= PASTE_CAP);
  assert.equal(cut.length, PASTE_CAP / 2);
});
