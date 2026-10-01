// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeWord, child, parent, crumbs, previewKind, readFile, listAll, whyNot, PREVIEW_MAX } from "./drive-browse.js";

test("sizes read plainly", () => {
  assert.deepEqual([0, 1023, 1024, 1536, 10 * 1024, 5 * 1024 * 1024].map(sizeWord), ["0 B", "1023 B", "1 KB", "1.5 KB", "10 KB", "5 MB"]);
});

test("paths: child, parent and the trail", () => {
  assert.equal(child("", "a"), "/a");
  assert.equal(child("/a/b/", "c"), "/a/b/c");
  assert.equal(parent("/a/b/c"), "/a/b");
  assert.equal(parent("/a"), "");
  assert.deepEqual(crumbs("work", "/a/b"), [{ label: "work", path: "" }, { label: "a", path: "/a" }, { label: "b", path: "/a/b" }]);
});

test("previewKind: pictures, text and PDF open; the rest download", () => {
  assert.equal(previewKind({ kind: "image", mime: "image/png" }), "image");
  assert.equal(previewKind({ mime: "image/svg+xml" }), "other");
  assert.equal(previewKind({ mime: "text/markdown" }), "text");
  assert.equal(previewKind({ mime: "application/json" }), "text");
  assert.equal(previewKind({ mime: "application/pdf" }), "pdf");
  assert.equal(previewKind({ mime: "application/zip" }), "other");
  assert.equal(previewKind({ dir: true, mime: "text/plain" }), "other");
});

/** A fake box: one file served in 4-byte chunks the way files.drive.read answers. */
const box = (/** @type {Buffer} */ file) => async (/** @type {string} */ name, /** @type {any} */ i) => {
  assert.equal(name, "files.drive.read");
  const buf = file.subarray(i.offset, i.offset + 4);
  return { data: { size: file.length, mime: "text/plain", base64: buf.toString("base64"), done: i.offset + buf.length >= file.length } };
};

test("readFile joins the chunks into the whole file", async () => {
  const file = Buffer.from("hello, phone files");
  const r = await readFile(box(file), "work", "/a.txt");
  assert.ok("bytes" in r);
  assert.equal(Buffer.from(r.bytes).toString(), "hello, phone files");
  assert.equal(r.size, file.length);
});

test("readFile refuses a file over the cap after one chunk, and passes a refusal through", async () => {
  let calls = 0;
  const big = async () => { calls++; return { data: { size: PREVIEW_MAX + 1, mime: "video/mp4", base64: "AAAA", done: false } }; };
  assert.deepEqual(await readFile(big, "w", "/v.mp4"), { tooBig: true, size: PREVIEW_MAX + 1, mime: "video/mp4" });
  assert.equal(calls, 1);
  const err = { code: "not_available" };
  assert.deepEqual(await readFile(async () => ({ error: err }), "w", "/x"), { error: err });
});

test("listAll follows next until it stops", async () => {
  const pages = [{ entries: [{ name: "a" }], next: 1 }, { entries: [{ name: "b" }] }];
  const seen = [];
  const r = await listAll(async (_n, i) => { seen.push(i.offset); return { data: pages[i.offset] }; }, "w", "");
  assert.deepEqual(r, { entries: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(seen, [0, 1]);
});

test("whyNot: one line for every refusal, no share or path named", () => {
  assert.match(whyNot({ code: "not_available", message: "x" }), /not available/);
  assert.match(whyNot({ missing: true }), /Files tools/);
});
