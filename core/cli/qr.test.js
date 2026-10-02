// @ts-check
// The terminal QR code: the vendored encoder (deck/vendor/qrcode.js) at level M in byte mode,
// pinned for a server address and a relay pair URL longer than version 10 holds, plus the parts a
// scanner reads first and the half-block drawing.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { qr, terminal } from "./qr.js";

const hash = m => crypto.createHash("sha256").update(m.map(r => r.map(b => (b ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);

test("qr: a server address matches the encoder this file was checked against, and a relay pair URL fits", () => {
  // The same matrix the previous, independently checked encoder gave for this address.
  const short = qr("https://vyre.tail0000.ts.net/");
  assert.equal(short.length, 29, "version 3");
  assert.equal(hash(short), "523a8700eb6d9c56");
  // A pair URL with a 64-character box name is about 260 characters: past version 10's 213 bytes.
  const pair = "https://vyre.run/pair#" + "x".repeat(240);
  assert.equal(qr(pair).length, 65, "version 12");
  assert.ok(qr("é").length === 21, "UTF-8 text in byte mode");
});

test("qr: finder patterns, timing, sizes and limits", () => {
  const m = qr("a");
  assert.equal(m.length, 21, "version 1");
  const ring = [0, 1, 2, 3, 4, 5, 6].map(i => m[0][i]);
  assert.deepEqual(ring, [true, true, true, true, true, true, true]);
  assert.deepEqual([m[1][0], m[1][1], m[1][5], m[1][6]], [true, false, false, true]);
  assert.deepEqual([8, 9, 10, 11, 12].map(i => m[6][i]), [true, false, true, false, true], "timing row");
  assert.equal(m[21 - 8][8], true, "the dark module");
  assert.equal(qr("x".repeat(213)).length, 57, "version 10 holds 213 bytes");
  assert.equal(qr("x".repeat(214)).length, 61, "and one more byte is version 11");
});

test("qr: terminal lines pair two rows per line, with a quiet zone", () => {
  const m = qr("a");
  const lines = terminal(m, { quiet: 2, indent: "" });
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.equal((lines[0].match(/▀/g) || []).length, 25);
  assert.ok(lines.every(l => l.endsWith("\x1b[0m")));
});
