import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { greyShare } from "./png-grey.mjs";

/** A 4x2 RGBA PNG: the left half solid (128,128,128), the right half white. */
function png() {
  const w = 4, h = 2, raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; for (let x = 0; x < w; x++) raw.set(x < 2 ? [128, 128, 128, 255] : [255, 255, 255, 255], y * (1 + w * 4) + 1 + x * 4); }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("the share of a screenshot that is the proof screen's grey is read from the PNG", () => {
  assert.equal(greyShare(png()), 0.5);
});
