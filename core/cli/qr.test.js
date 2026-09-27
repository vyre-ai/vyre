// @ts-check
// The QR encoder, against matrices checked module for module with an independent encoder (the
// qrcode package, byte mode, level M, the same mask) when this file was written: a version 3
// code, and a version 9 one that carries version information. Plus the parts a scanner reads first.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { qr, terminal } from "./qr.js";

const hash = m => crypto.createHash("sha256").update(m.map(r => r.map(b => (b ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);

test("qr: matrices match an independent encoder", () => {
  const short = qr("https://vyre.tail0000.ts.net/", { mask: 2 });
  assert.equal(short.length, 29, "version 3");
  assert.equal(hash(short), "f2e7ab9ccbfc590a");
  const long = qr("https://alex.vyre.run/" + "y".repeat(140), { mask: 5 });
  assert.equal(long.length, 53, "version 9");
  assert.equal(hash(long), "35400178e9e06564");
  const auto = hash(qr("https://vyre.tail0000.ts.net/"));
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].some(k => hash(qr("https://vyre.tail0000.ts.net/", { mask: k })) === auto), "the chosen mask is one of the eight, fully applied");
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
  assert.throws(() => qr("x".repeat(214)), /too long/);
});

test("qr: terminal lines pair two rows per line, with a quiet zone", () => {
  const m = qr("a");
  const lines = terminal(m, { quiet: 2, indent: "" });
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.equal((lines[0].match(/▀/g) || []).length, 25);
  assert.ok(lines.every(l => l.endsWith("\x1b[0m")));
});
