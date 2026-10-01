// @ts-check
// The multi-file diff (diff-files.js) in the fake DOM: which files start open, per-file state,
// Expand all, counts, binary and too-large files, patch text. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
});

const { diffFiles, fileList, parsePatch, TOO_LARGE } = await import("./diff-files.js");

const hunk = (o = 1, lines = [" keep", "-old", "+new"]) => [{ oldStart: o, newStart: o, lines }];
const FILES = () => [
  { path: "prices.json", status: "modified", additions: 4, deletions: 1, hunks: hunk() },
  { path: "src/menu/PriceList.js", additions: 12, deletions: 4, hunks: hunk(10) },
  { path: "src/menu/PriceList.test.js", status: "added", additions: 24, deletions: 0, hunks: hunk(1, ["+one", "+two"]) },
];

test("parsePatch: GitHub patch text becomes hunks, headers and no-newline markers dropped", () => {
  const p = parsePatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more\n\\ No newline at end of file\n@@ -20 +21 @@\n-a\n+b\n");
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { oldStart: 3, newStart: 3, lines: [" keep", "-old", "+new", "+more"] });
  assert.deepEqual(p[1].lines, ["-a", "+b"]);
  assert.deepEqual(parsePatch(""), []);
});

test("file list: desktop opens the first file only, each row carries its counts, a phone opens none", () => {
  const l = fileList(FILES(), { phone: false });
  assert.deepEqual($$(l, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["true", "false", "false"]);
  assert.equal($$(l, ".cv-diff").length, 1);
  assert.match(text($$(l, ".cv-df-row")[1]), /src\/menu\/PriceList\.js\s*\+12 −4/);
  assert.match(text($$(l, ".cv-df-row")[2]), /new · \+24/, "a new file reads new · +24");
  assert.match(text($(l, ".cv-dfl-bar")), /3 files · \+40 −5/);
  const p = fileList(FILES(), { phone: true });
  assert.deepEqual($$(p, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["false", "false", "false"]);
  assert.equal($$(p, ".cv-diff").length, 0);
});

test("file list: files open and close on their own; Expand all and Collapse all set every file; a caller can open one by default", () => {
  const seen = [];
  const l = fileList(FILES(), { phone: false, onToggle: (p, o) => seen.push([p, o]) });
  $$(l, ".cv-df-row")[2].click();
  assert.deepEqual($$(l, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["true", "false", "true"]);
  assert.deepEqual(seen, [["src/menu/PriceList.test.js", true]]);
  $$(l, ".cv-df-row")[0].click();
  assert.equal(l.isOpen("prices.json"), false);
  assert.equal(l.isOpen("src/menu/PriceList.test.js"), true, "closing one leaves the others");
  assert.equal(text($(l, "[data-act=all]")), "Expand all");
  $(l, "[data-act=all]").click();
  assert.equal($$(l, ".cv-diff").length, 3);
  assert.equal(text($(l, "[data-act=all]")), "Collapse all");
  $(l, "[data-act=all]").click();
  assert.equal($$(l, ".cv-diff").length, 0);
  const c = fileList(FILES(), { phone: true, open: ["src/menu/PriceList.js"] });
  assert.equal(c.isOpen("src/menu/PriceList.js"), true);
  assert.equal(c.isOpen("prices.json"), false);
});

test("file list: update keeps what the person opened, adds new files closed, drops removed ones", () => {
  const l = fileList(FILES(), { phone: false });
  l.setOpen("src/menu/PriceList.js", true);
  l.update([...FILES().slice(1), { path: "README.md", additions: 1, deletions: 0, hunks: hunk() }]);
  assert.deepEqual(l.paths(), ["src/menu/PriceList.js", "src/menu/PriceList.test.js", "README.md"]);
  assert.equal(l.isOpen("src/menu/PriceList.js"), true);
  assert.equal(l.isOpen("README.md"), false);
  assert.equal(l.isOpen("prices.json"), false);
});

test("file list: patch text draws the same rows; counts come from the rows when the data has none", () => {
  const l = fileList([{ path: "a.txt", patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+newer" }], { phone: false });
  assert.match(text($(l, ".cv-df-row")), /\+2 −1/);
  assert.equal($$(l, ".cv-dl-add").length, 2);
  assert.equal($$(l, ".cv-dl-del").length, 1);
});

test("file list: a binary file and a file with no hunks say so; a huge one says Open it in Files and never blocks the rest", () => {
  const big = { path: "big.txt", hunks: hunk(1, Array.from({ length: TOO_LARGE + 1 }, (_, i) => "+line " + i)) };
  const opened = [];
  const l = fileList([{ path: "logo.png", binary: true }, { path: "empty.md" }, big, FILES()[0]], { phone: false, open: ["logo.png", "empty.md", "big.txt"], openFile: f => opened.push(f.path) });
  assert.match(text(l), /Binary file changed/);
  assert.match(text(l), /No line changes to show/);
  assert.match(text(l), /This diff has 4,001 lines\. Open it in Files\./);
  assert.equal($$(l, ".cv-dl").length, 0, "no rows drawn for the huge one");
  $(l, ".cv-df-big .btn").click();
  assert.deepEqual(opened, ["big.txt"]);
  l.setOpen("prices.json", true);
  assert.ok($$(l, ".cv-dl").length > 0, "the next file still draws");
});

test("diff card: title, total counts, the list; empty says so; the aria label is the title", () => {
  const c = diffFiles({ kind: "diff", title: "Price list changes", files: FILES() }, { phone: false });
  assert.equal(c.getAttribute("aria-label"), "Price list changes");
  assert.match(text($(c, ".cv-card-head")), /Price list changes\s*\+40 −5/);
  assert.equal($$(c, ".cv-df").length, 3);
  c.update({ kind: "diff", files: [] });
  assert.match(text(c), /No files changed/);
  assert.equal(c.getAttribute("aria-label"), "Changes");
  const d = diffFiles({ files: [{ path: "x.js", hunks: hunk() }] }, { phone: false });
  assert.equal(d.getAttribute("aria-label"), "Changes");
});
