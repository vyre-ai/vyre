// @ts-check
// The terminal QR: the vendored encoder is the pinned file, the matrix is a real QR (structure checks here; a decode with jsQR was run once and is
// recorded in docs/work/tailnet.md), and the art is two QR rows per text row in four glyphs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { qrMatrix, qrLines, qrArt } from "./qr.js";

const dir = new URL("./vendor/", import.meta.url);
const P = "vyre://wink/2?t=AAECAwQFBgcICQoLDA0ODw&r=wss%3A%2F%2Frelay.vyre.run";

test("vendor: qrcode-generator.js matches vendor/PINS-qr.json, byte for byte the npm file", () => {
  const pins = JSON.parse(readFileSync(new URL("PINS-qr.json", dir), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(new URL(pins.file, dir))).digest("hex"), pins.sha256);
  assert.match(pins.source.integrity, /^sha512-/);
  assert.match(readFileSync(new URL("LICENSE.qrcode-generator", dir), "utf8"), /MIT/);
});

test("qr: a square matrix with the three finder patterns", () => {
  const m = qrMatrix(P);
  assert.equal(m.length, m[0].length);
  assert.ok((m.length - 17) % 4 === 0 && m.length >= 21 && m.length <= 57, `version size ${m.length}`);
  const finder = (/** @type {number} */ r0, /** @type {number} */ c0) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6, core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.equal(m[r0 + r][c0 + c], edge || core, `finder at ${r0},${c0} cell ${r},${c}`);
    }
  };
  finder(0, 0); finder(0, m.length - 7); finder(m.length - 7, 0);
  assert.deepEqual(qrMatrix(P), m, "the same text gives the same code");
});

test("qr: art is half the rows, four glyphs, a quiet zone, and a payload of a pairing ticket fits a terminal", () => {
  const n = qrMatrix(P).length;
  const lines = qrLines(P);
  assert.equal(lines.length, Math.ceil((n + 4) / 2));
  assert.ok(lines.every(l => l.length === n + 4));
  assert.ok(lines.every(l => /^[ ▀▄█]+$/.test(l)));
  assert.equal(lines[0], " ".repeat(n + 4), "two light rows of quiet zone on top");
  assert.ok(lines[0].length <= 80);
  assert.equal(qrArt(P), lines.join("\n"));
  assert.equal(qrLines(P, { quiet: 0 })[0].length, n);
});

test("qr: only printable ASCII, and not too long", () => {
  for (const bad of ["", "café", "a\nb", "x".repeat(201), /** @type {any} */ (null)]) assert.throws(() => qrMatrix(bad));
});
