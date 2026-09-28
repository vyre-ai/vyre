// @ts-check
// Inline pictures (cohesion item 18), the DOM-free half: what counts as a picture, when it is too
// big to inline, and the data: URL / sight.frame shaping. No DOM here on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataUrl, frameToPicture, humanSize, inlineable, INLINE_LIMIT_BYTES, isPicture, tooLarge } from "./images.js";

const PIC = { media_type: "image/png", data: "QUJD", name: "invoice.png", size: 2048 };

test("isPicture: a media_type and some data; anything else (or not an image) is not one", () => {
  assert.equal(isPicture(PIC), true);
  assert.equal(isPicture({ media_type: "image/png", data: "" }), false);
  assert.equal(isPicture({ media_type: "text/plain", data: "x" }), false);
  assert.equal(isPicture(null), false);
  assert.equal(isPicture({}), false);
});

test("inlineable / tooLarge split a list by INLINE_LIMIT_BYTES; a bare number and a non-image are dropped from both", () => {
  const big = { media_type: "image/jpeg", data: "x", size: INLINE_LIMIT_BYTES + 1 };
  const notAPic = { media_type: "application/pdf", data: "x", size: 10 };
  const list = [PIC, big, notAPic, 3];
  assert.deepEqual(inlineable(list), [PIC]);
  assert.deepEqual(tooLarge(list), [big]);
  assert.deepEqual(inlineable(null), []);
  assert.deepEqual(tooLarge(undefined), []);
});

test("inlineable: no size at all is treated as small enough (a sight.frame still carries no size)", () => {
  assert.deepEqual(inlineable([{ media_type: "image/jpeg", data: "x" }]), [{ media_type: "image/jpeg", data: "x" }]);
});

test("dataUrl: media_type and base64 data, joined plainly", () => {
  assert.equal(dataUrl(PIC), "data:image/png;base64,QUJD");
});

test("frameToPicture: sight.frame's answer as a Picture, or null with nothing to show", () => {
  assert.deepEqual(frameToPicture({ image: "QUJD", mime: "image/jpeg" }), { media_type: "image/jpeg", data: "QUJD", name: "Screen" });
  assert.equal(frameToPicture({ image: null, mime: "image/jpeg" }), null);
  assert.equal(frameToPicture({ target: "agent:kit" }), null);
  assert.equal(frameToPicture(null), null);
});

test("humanSize: bytes, KB, MB, plainly", () => {
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(2048), "2 KB");
  assert.equal(humanSize(3 * 1024 * 1024), "3.0 MB");
  assert.equal(humanSize(-1), "");
  assert.equal(humanSize(NaN), "");
});
