import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PHOTO_MAX_BYTES, PHOTO_SIDE, QUALITIES, ZOOM_MAX, base64Bytes, clampView, cropRect, nextQuality, outputSide, placement, sniff, stripMeta } from "./photo-crop-model.js";

const S = 320;
const views = [];
for (const [w, h] of [[4032, 3024], [3024, 4032], [1080, 1080], [640, 360], [300, 200], [180, 180]])
  for (const zoom of [1, 1.7, ZOOM_MAX, 9, 0.2])
    for (const [x, y] of [[0, 0], [400, -400], [-90000, 90000], [17.3, -2.4]]) views.push({ w, h, stage: S, zoom, x, y });

test("the kept part is always square and inside the picture, whatever the drag and the zoom", () => {
  for (const v of views) {
    const c = cropRect(v);
    const say = JSON.stringify({ v, c });
    assert.equal(c.width, c.height, `square: ${say}`);
    assert.ok(c.width >= 1 && c.width <= Math.min(v.w, v.h), `fits: ${say}`);
    assert.ok(c.originX >= 0 && c.originY >= 0 && c.originX + c.width <= v.w && c.originY + c.height <= v.h, `inside: ${say}`);
    for (const k of ["originX", "originY", "width", "height"]) assert.ok(Number.isInteger(c[k]), `whole pixels: ${say}`);
  }
});

test("the picture always covers the circle: no drag shows an empty corner, and the zoom stays between 1 and the most", () => {
  for (const v of views) {
    const c = clampView(v), p = placement(v);
    assert.ok(c.zoom >= 1 && c.zoom <= ZOOM_MAX, JSON.stringify(c));
    assert.ok(p.left <= 0.0001 && p.top <= 0.0001 && p.left + p.width >= S - 0.0001 && p.top + p.height >= S - 0.0001, JSON.stringify({ v, p }));
  }
});

test("at the start the middle of the picture is kept, and zooming in keeps less of it around the same middle", () => {
  assert.deepEqual(cropRect({ w: 4000, h: 3000, stage: S, zoom: 1, x: 0, y: 0 }), { originX: 500, originY: 0, width: 3000, height: 3000 });
  assert.deepEqual(cropRect({ w: 4000, h: 3000, stage: S, zoom: 2, x: 0, y: 0 }), { originX: 1250, originY: 750, width: 1500, height: 1500 });
  // dragged all the way right: the left edge of the picture
  assert.equal(cropRect({ w: 4000, h: 3000, stage: S, zoom: 1, x: 1e6, y: 0 }).originX, 0);
});

test("the saved photo is at most 512 pixels a side, never blown up, and at most 200 KB", () => {
  assert.equal(PHOTO_SIDE, 512);
  assert.equal(PHOTO_MAX_BYTES, 200 * 1024);
  for (const v of views) { const side = outputSide(cropRect(v)); assert.ok(side >= 1 && side <= 512 && side <= Math.min(v.w, v.h), String(side)); }
  assert.equal(outputSide({ width: 3000 }), 512);
  assert.equal(outputSide({ width: 180 }), 180);
  // the qualities step down and end, so a heavy picture is tried a few times and then refused in words
  let q = QUALITIES[0], n = 1;
  while (nextQuality(q) !== null) { const next = /** @type {number} */ (nextQuality(q)); assert.ok(next < q); q = next; n++; }
  assert.equal(n, QUALITIES.length);
  assert.equal(nextQuality(0.5), null);
  assert.equal(base64Bytes(Buffer.alloc(204800).toString("base64")), 204800);
  assert.equal(base64Bytes(Buffer.alloc(10).toString("base64")), 10);
  assert.equal(base64Bytes(Buffer.alloc(11).toString("base64")), 11);
});

// --- notes in a picture: EXIF (with a place) and XMP are taken out, the picture stays
const be16 = (n) => [(n >> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const has = (b, s) => Buffer.from(b).includes(Buffer.from(s, "latin1"));

test("a JPEG keeps its header and picture and loses its EXIF, location, XMP and comments", () => {
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  const exif = seg(0xe1, ascii("Exif\0\0GPSLatitude 51.5N GPSLongitude 0.12W"));
  const xmp = seg(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>place</x:xmpmeta>"));
  const app0 = seg(0xe0, ascii("JFIF\0\x01\x01"));
  const com = seg(0xfe, ascii("taken at home"));
  const dqt = seg(0xdb, [0, 1, 2, 3]);
  const scan = [0xff, 0xda, 0, 4, 9, 9, 1, 2, 3, 0xff, 0xd9];
  const pic = Uint8Array.from([0xff, 0xd8, ...app0, ...exif, ...xmp, ...com, ...dqt, ...scan]);
  assert.equal(sniff(pic), "image/jpeg");
  const out = stripMeta(pic);
  assert.deepEqual([...out], [0xff, 0xd8, ...app0, ...dqt, ...scan]);
  for (const s of ["Exif", "GPS", "xmpmeta", "taken at home"]) assert.ok(!has(out, s), s);
});

test("a WebP loses its EXIF and XMP chunks, says so in its header, and keeps its size right", () => {
  const chunk = (t, body) => [...ascii(t), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
  const vp8x = chunk("VP8X", [0x0c | 0x10, 0, 0, 0, 255, 1, 0, 255, 1, 0]);
  const vp8 = chunk("VP8 ", [1, 2, 3, 4, 5, 6]);
  const exif = chunk("EXIF", ascii("GPSLatitude 51.5N"));
  const xmp = chunk("XMP ", ascii("<x:xmpmeta/>"));
  const body = [...ascii("WEBP"), ...vp8x, ...vp8, ...exif, ...xmp];
  const pic = Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
  assert.equal(sniff(pic), "image/webp");
  const out = stripMeta(pic);
  assert.ok(!has(out, "EXIF") && !has(out, "GPS") && !has(out, "XMP"), "no notes");
  assert.ok(has(out, "VP8 "), "the picture is kept");
  assert.equal(out[20] & 0x0c, 0, "the header no longer says it has EXIF or XMP");
  assert.equal(out[20] & 0x10, 0x10, "and keeps its other flags");
  assert.equal(Buffer.from(out).readUInt32LE(4), out.length - 8, "the RIFF size matches");
});

test("a PNG loses eXIf and its text chunks and keeps the rest", () => {
  const chunk = (t, body) => [...be32(body.length), ...ascii(t), ...body, 0, 0, 0, 0];
  const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const exif = chunk("eXIf", ascii("GPS 51.5N"));
  const text = chunk("tEXt", ascii("Location\0home"));
  const idat = chunk("IDAT", [1, 2, 3]);
  const iend = chunk("IEND", []);
  const pic = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...exif, ...text, ...idat, ...iend]);
  const out = stripMeta(pic);
  assert.deepEqual([...out], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat, ...iend]);
});

test("bytes that are not a picture it knows, or that it cannot follow, come back unchanged", () => {
  const junk = Uint8Array.from([1, 2, 3, 4, 5]);
  assert.equal(stripMeta(junk), junk);
  const cut = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]);
  assert.equal(stripMeta(cut), cut);
  assert.equal(sniff(junk), "");
});
