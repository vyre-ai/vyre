// @ts-check
// The vendored decoder reads the codes this repo draws, at the sizes and margins a phone camera gives.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "./jsqr.js";
import { qr } from "../../../core/cli/qr.js";
import { seedQrText, newSeed } from "../../../relay/client/seedwords.js";
import { nodeCrypto } from "../../../relay/client/nodecrypto.js";

/** Draw a code as RGBA at `scale` pixels per module with a quiet zone, optionally rotated by 180. */
function draw(rows, scale, quiet = 4) {
  const n = rows.length, size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rows[y][x])
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const o = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      data[o] = data[o + 1] = data[o + 2] = 0;
    }
  return { data, size };
}

test("jsQR (vendored) reads the Windows pairing QR at several scales", () => {
  const text = seedQrText(newSeed(nodeCrypto()));
  for (const scale of [3, 5, 8]) {
    const { data, size } = draw(qr(text), scale);
    const r = jsQR(data, size, size);
    assert.equal(r && r.data, text, `scale ${scale}`);
  }
});

test("jsQR (vendored) finds nothing in a blank frame, and is a plain function with no network", () => {
  const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  assert.equal(jsQR(blank, 200, 200), null);
  assert.equal(typeof jsQR, "function");
});
