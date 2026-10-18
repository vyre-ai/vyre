// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canDrop, carriesFiles, dropTarget, dropWords, plan, progressLine } from "./drop-model.js";

const space = (/** @type {string} */ path, over = {}) => ({ place: `space:${path}`, root: "space", path, ...over });

test("only the Space and a linked folder take uploads", () => {
  assert.equal(canDrop({ root: "space" }), true);
  assert.equal(canDrop({ root: "linked", link: "l1" }), true);
  for (const root of ["linked", "box", "shared", "computer"]) assert.equal(canDrop({ root }), false, root);
});

test("a drop lands in the folder row under the pointer, else in the open folder, else nowhere", () => {
  const open = space("Clients");
  const row = { ...space("Clients/A"), dir: true };
  assert.equal(dropTarget(open, row), row);
  assert.equal(dropTarget(open, { ...row, dir: false }), open, "a file row is not a target");
  assert.equal(dropTarget(open, { place: "box:x", root: "box", path: "x", dir: true }), open, "a folder that takes no files falls back");
  assert.equal(dropTarget(open, null), open);
  assert.equal(dropTarget({ place: "box:x", root: "box", path: "" }, null), null);
  assert.equal(dropTarget(null, null), null);
});

test("the highlight says where, and says plainly when nothing takes the drop", () => {
  assert.equal(dropWords(space("Clients"), (f) => f.path), "Drop to upload to Clients");
  assert.equal(dropWords(null, () => ""), "Files cannot be dropped here");
});

test("only a drag of files from outside counts", () => {
  assert.equal(carriesFiles({ types: ["Files", "text/plain"] }), true);
  assert.equal(carriesFiles({ types: ["text/plain"] }), false);
  assert.equal(carriesFiles(null), false);
});

test("files over the cap and dropped folders are left out with a reason, the rest go", () => {
  const out = plan([{ name: "a.pdf", size: 10, type: "application/pdf" }, { name: "big.mov", size: 99, type: "video/quicktime" }, { name: "Folder", size: 0, type: "" }, { name: "empty.txt", size: 0, type: "text/plain" }], 50);
  assert.deepEqual(out.go.map((f) => f.name), ["a.pdf", "empty.txt"]);
  assert.deepEqual(out.skipped, [{ name: "big.mov", why: "too_large" }, { name: "Folder", why: "not_a_file" }]);
});

test("progress reads as one file or n of m", () => {
  assert.equal(progressLine(0, 1, "a.pdf"), "Uploading a.pdf");
  assert.equal(progressLine(1, 5, "b.pdf"), "Uploading 2 of 5: b.pdf");
});
