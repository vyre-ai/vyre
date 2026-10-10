// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS as BOX } from "../../../../lib/attachments.js";
import { LIMITS, sizeWord, whyNot, uploading, ready, failed, without, toSend, chipLine, defaultWords } from "./attach-model.js";

test("the composer's limits are the box's", () => {
  for (const k of ["perMessage", "imageBytes", "fileBytes", "messageBytes"]) assert.equal(/** @type {any} */ (LIMITS)[k], /** @type {any} */ (BOX)[k], k);
});

test("a file is refused in words before an upload is tried", () => {
  const f = (name, mime, bytes) => ({ name, mime, bytes });
  assert.equal(whyNot([], f("a.pdf", "application/pdf", 1000)), "");
  assert.match(whyNot([], f("empty.txt", "text/plain", 0)), /empty/);
  assert.match(whyNot([], f("big.png", "image/png", 5 * 1024 * 1024 + 1)), /over 5 MB\./);
  assert.match(whyNot([], f("big.pdf", "application/pdf", 8 * 1024 * 1024 + 1)), /over 8 MB; a larger file goes through a Flow/);
  const five = Array.from({ length: 5 }, (_, i) => uploading(`k${i}`, f(`${i}.txt`, "text/plain", 10)));
  assert.match(whyNot(five, f("x.txt", "text/plain", 1)), /At most 5 files/);
  assert.equal(whyNot(failed(five, "k0", "no"), f("x.txt", "text/plain", 1)), "", "a failed one does not count");
  const three = Array.from({ length: 3 }, (_, i) => uploading(`k${i}`, f(`${i}.pdf`, "application/pdf", 7 * 1024 * 1024)));
  assert.match(whyNot(three, f("y.pdf", "application/pdf", 1024 * 1024)), /Together the files are over 20 MB/);
});

test("chips go from adding to ready or failed, and a send carries the ready ones and waits on the rest", () => {
  const a = { id: "att_x".padEnd(26, "x"), name: "a.pdf", mime: "application/pdf", bytes: 2048 };
  let chips = [uploading("1", { name: "a.pdf", mime: "application/pdf", bytes: 2048 }), uploading("2", { name: "b.txt", mime: "text/plain", bytes: 10 })];
  assert.deepEqual(toSend(chips), { attachments: [], waiting: true });
  chips = ready(chips, "1", a);
  assert.deepEqual(toSend(chips), { attachments: [a], waiting: true });
  chips = failed(chips, "2", "That file could not be saved");
  assert.deepEqual(toSend(chips), { attachments: [a], waiting: false });
  assert.deepEqual(chips.map(chipLine), ["2 KB", "That file could not be saved"]);
  assert.equal(chipLine(uploading("3", { name: "c", mime: "x/y", bytes: 3 * 1024 * 1024 })), "3.0 MB · adding");
  assert.deepEqual(without(chips, "2").map((c) => c.key), ["1"]);
  assert.equal(sizeWord(10), "1 KB");
  assert.deepEqual([defaultWords(1), defaultWords(2)], ["Here is a file.", "Here are some files."]);
});

test("thumbnails: a picture of up to 2 MB has one from its own bytes, any other file has none, and a sent picture is remembered by id", async () => {
  const { thumbOf, uploading, isImage, rememberThumb, thumbFor } = await import("./attach-model.js");
  const png = { name: "a.png", mime: "image/png", bytes: 1000, base64: "iVBOR" };
  assert.equal(thumbOf(png), "data:image/png;base64,iVBOR");
  assert.equal(thumbOf({ ...png, mime: "IMAGE/JPEG" }), "data:image/jpeg;base64,iVBOR");
  assert.equal(thumbOf({ ...png, bytes: 3 * 1024 * 1024 }), undefined, "a big picture shows its name, not a heavy thumbnail");
  assert.equal(thumbOf({ name: "x.pdf", mime: "application/pdf", bytes: 10, base64: "JVBER" }), undefined);
  assert.equal(thumbOf({ name: "a.png", mime: "image/png", bytes: 10 }), undefined, "no bytes read, no thumbnail");
  assert.equal(uploading("k", png).thumb, "data:image/png;base64,iVBOR");
  assert.equal(uploading("k", { ...png, mime: "text/plain" }).thumb, undefined);
  assert.deepEqual([isImage("image/gif"), isImage("application/pdf")], [true, false]);
  rememberThumb("att_1", "data:image/png;base64,AA");
  assert.equal(thumbFor("att_1"), "data:image/png;base64,AA");
  assert.equal(thumbFor("att_none"), undefined);
});
