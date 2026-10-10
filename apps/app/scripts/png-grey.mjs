// How much of a screenshot is the proof screen's solid grey (128,128,128): `node png-grey.mjs shot.png` prints the share (0..1) of pixels within 6 of it. Reads the 8-bit, non-interlaced PNG adb screencap writes; no dependency.
import fs from "node:fs";
import zlib from "node:zlib";

export function greyShare(buf) {
  if (buf.subarray(1, 4).toString() !== "PNG") throw new Error("not a PNG");
  let w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.subarray(i + 4, i + 8).toString(), data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; if (data[12] !== 0) throw new Error("interlaced"); }
    if (type === "IDAT") idat.push(data);
    i += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`colour type ${ct} depth ${bd} is not read here`);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), grey = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      cur[x] = f === 0 ? line[x] : f === 1 ? (line[x] + a) & 255 : f === 2 ? (line[x] + b) & 255 : f === 3 ? (line[x] + ((a + b) >> 1)) & 255
        : (line[x] + (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })()) & 255;
    }
    for (let x = 0; x < w; x++) if (Math.abs(cur[x * bpp] - 128) <= 6 && Math.abs(cur[x * bpp + 1] - 128) <= 6 && Math.abs(cur[x * bpp + 2] - 128) <= 6) grey++;
    [prev, cur] = [cur, prev];
  }
  return grey / (w * h);
}

if (process.argv[1] && process.argv[1].endsWith("png-grey.mjs") && process.argv[2]) console.log(greyShare(fs.readFileSync(process.argv[2])).toFixed(4));
