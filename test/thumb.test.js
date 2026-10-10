// @ts-check
// lib/thumb and attachments.get: an image gets a preview of at most 256 pixels without any image library; what cannot be shrunk here is sent as the file itself or not at all.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { encodePng, decodePng, thumbOf, THUMB_SIDE, SMALL_BYTES } from "../lib/thumb.js";
import { registerAttachments } from "../core/attachments/index.js";

/** A w x h PNG that is red on the left half and blue on the right, with noise so it does not compress to nothing. */
const png = (/** @type {number} */ w, /** @type {number} */ h) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const left = i % w < w / 2; px.set([left ? 255 : 0, 0, left ? 0 : 255, 255], i * 4); }
  return new Uint8Array(encodePng(w, h, px));
};

test("a large PNG shrinks to the preview side and keeps its colours", () => {
  const big = png(1200, 600);
  const t = thumbOf(big, "image/png");
  assert.ok(t && t.mime === "image/png");
  const img = decodePng(t.bytes);
  assert.ok(img);
  assert.equal(Math.max(img.w, img.h), THUMB_SIDE);
  assert.equal(img.h, 128, "the shape is kept");
  assert.deepEqual([...img.rgba.slice(0, 4)], [255, 0, 0, 255], "red on the left");
  const last = (img.w - 1) * 4;
  assert.deepEqual([...img.rgba.slice(last, last + 4)], [0, 0, 255, 255], "blue on the right");
  assert.ok(t.bytes.length < big.length);
});

test("a small PNG is its own preview and a damaged one has none", () => {
  const small = png(40, 20);
  assert.ok(small.length <= SMALL_BYTES);
  assert.equal(thumbOf(small, "image/png")?.bytes, small);
  assert.equal(thumbOf(new Uint8Array(SMALL_BYTES + 1), "image/png"), null, "a PNG that does not decode and is not small has none");
  assert.equal(thumbOf(png(1200, 600).slice(0, 60).fill(7, 10), "image/png")?.bytes.length, 60, "a damaged small one goes whole");
});

test("another image type is its own preview only when small", () => {
  assert.equal(thumbOf(new Uint8Array(1000), "image/jpeg")?.bytes.length, 1000);
  assert.equal(thumbOf(new Uint8Array(SMALL_BYTES + 1), "image/jpeg"), null);
  assert.equal(thumbOf(new Uint8Array(10), "application/pdf"), null);
});

test("attachments.get answers the file, its preview, or no preview, and only for a file of the chat", async () => {
  const folder = "proj/chat/c1";
  const big = png(900, 900);
  /** @type {Record<string, Uint8Array>} */ const files = { [`${folder}/att_aaaaaaaaaaaaaaaaaaaaaa-pic.png`]: big, [`${folder}/att_bbbbbbbbbbbbbbbbbbbbbb-note.pdf`]: new Uint8Array([37, 80, 68, 70]), [`${folder}/att_cccccccccccccccccccccc-shot.jpg`]: new Uint8Array(SMALL_BYTES + 5) };
  const gateway = {
    records: { query: async () => ({ rows: [{ data: { drive: "proj" } }] }) },
    drive: { list: async () => Object.entries(files).map(([path, b]) => ({ path, size: b.length })), get: async (/** @type {any} */ _c, /** @type {string} */ p) => files[p] },
  };
  /** @type {Record<string, any>} */ const tools = {};
  registerAttachments({ tool: (/** @type {string} */ n, /** @type {any} */ d) => { tools[n] = d; }, events: { emit() {} } }, { door: { open: async () => ({ gateway, chain: {} }) } });
  const get = (/** @type {any} */ i) => tools["attachments.get"].run({ thread: "c1", ...i }, {});
  const full = await get({ id: "att_aaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(full.thumb, false);
  assert.equal(Buffer.from(full.data, "base64").length, big.length, "no thumb flag: the file whole");
  const t = await get({ id: "att_aaaaaaaaaaaaaaaaaaaaaa", thumb: true });
  assert.equal(t.thumb, true);
  assert.equal(t.mime, "image/png");
  assert.ok(Buffer.from(t.data, "base64").length < big.length);
  const doc = await get({ id: "att_bbbbbbbbbbbbbbbbbbbbbb", thumb: true });
  assert.deepEqual([doc.thumb, doc.data], [false, null], "a document has no preview");
  const jpg = await get({ id: "att_cccccccccccccccccccccc", thumb: true });
  assert.equal(jpg.thumb, false, "a large JPEG comes whole: this build cannot shrink it");
  assert.equal(Buffer.from(jpg.data, "base64").length, SMALL_BYTES + 5);
  await assert.rejects(get({ id: "att_dddddddddddddddddddddd" }), /not in this chat/);
});
