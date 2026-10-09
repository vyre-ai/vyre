// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canPreview, fileIcon, groupFiles, previewKind, shareAction, shareLine, sizeLine, summary } from "./files-model.js";

const f = (/** @type {string} */ name, /** @type {any} */ o = {}) => ({ path: `Projects/p/chat/c/${name}`, name, kind: "received", size: 10, at: 0, shared: false, ...o });

test("a file previews by its name, and only small text and images", () => {
  assert.deepEqual(["a.PNG", "n.md", "d.pdf", "x"].map(previewKind), ["image", "text", "pdf", "other"]);
  assert.deepEqual(["a.png", "n.md", "d.PDF", "x.docx"].map(fileIcon), ["camera", "list", "file", "clip"], "a mark per kind of file");
  assert.equal(canPreview(f("a.txt")), true);
  assert.equal(canPreview(f("a.txt", { size: 300000 })), false);
  assert.equal(canPreview(f("a.pdf")), true, "a PDF renders");
  assert.equal(canPreview(f("a.pdf", { size: 9 * 1024 * 1024 })), false);
  assert.equal(canPreview(f("a.docx")), false);
  assert.equal(canPreview(f("a.png", { size: 5 * 1024 * 1024 })), false);
});

test("made and received are apart and sorted by name", () => {
  const g = groupFiles([f("b.txt"), f("a.txt"), f("z.png", { kind: "made" })]);
  assert.deepEqual(g.received.map(x => x.name), ["a.txt", "b.txt"]);
  assert.deepEqual(g.made.map(x => x.name), ["z.png"]);
});

test("a shared file says what the project sees and offers Unshare; a private one offers Share to project", () => {
  assert.match(shareLine(f("a", { shared: true })), /nothing else in the chat/);
  assert.equal(shareLine(f("a")), "Private to this chat");
  assert.deepEqual(shareAction(f("a")), { tool: "work.file.share", label: "Share to project" });
  assert.deepEqual(shareAction(f("a", { shared: true })), { tool: "work.file.unshare", label: "Unshare" });
});

test("sizes and the summary read plainly", () => {
  assert.deepEqual([5, 2048, 3 * 1048576].map(sizeLine), ["5 B", "2 KB", "3.0 MB"]);
  assert.equal(summary([]), "No files yet");
  assert.equal(summary([f("a", { shared: true }), f("b")]), "2 files, 1 shared");
  assert.equal(summary([f("a")]), "1 file, 0 shared");
});
