// @ts-check
// The file and link preview chip in the fake DOM: what it shows, where a tap goes, what it
// refuses to fetch, and previewsIn on a line of prose. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
});
const { filePreview, previewRow, previewsIn, describe, safeThumb, safeUrl, sizeLabel } = await import("./file-preview.js");

const FILE = { kind: "file_preview", name: "Harlow-report.pdf", path: "/work/harlow/Harlow-report.pdf", size: 2_100_000, mime: "application/pdf" };

test("a file shows its name and 'size, kind', and a tap opens its path through ctx.open", () => {
  const opened = [];
  const el = filePreview(FILE, { open: (/** @type {string} */ h) => opened.push(h) });
  assert.match(text(el), /Harlow-report\.pdf/);
  assert.match(text(el), /2\.1 MB · PDF/);
  const b = $(el, "button");
  assert.equal(b.getAttribute("aria-label"), "Harlow-report.pdf, 2.1 MB · PDF");
  b.click();
  assert.deepEqual(opened, ["/work/harlow/Harlow-report.pdf"]);
});

test("file type falls back to the extension, and lines join the meta", () => {
  assert.equal(describe({ kind: "file_preview", name: "menu.md", path: "menu.md", size: 812, lines: 41 }).meta, "812 B · Markdown · 41 lines");
  assert.equal(describe({ kind: "file_preview", path: "a/b/notes.xyz", size: 340_000 }).meta, "340 KB · XYZ");
  assert.equal(describe({ kind: "file_preview", path: "a/b/notes.xyz" }).name, "notes.xyz");
});

test("a link shows its title, the domain as meta, and is an anchor that opens through ctx.open", () => {
  const opened = [];
  const el = filePreview({ kind: "link_preview", url: "https://www.northwind.example/menu?x=1", title: "Northwind menu" }, { open: (/** @type {string} */ h) => opened.push(h) });
  const a = $(el, "a");
  assert.match(text(el), /Northwind menu/);
  assert.match(text(el), /northwind\.example/);
  assert.ok(!text(el).includes("https://"));
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  assert.equal(a.getAttribute("target"), "_blank");
  const ev = new Event("click");
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(opened, ["https://www.northwind.example/menu?x=1"]);
});

test("without ctx.open a link just follows its anchor", () => {
  const el = filePreview({ kind: "link_preview", url: "https://harlow.example/a", title: "Harlow" }, {});
  const ev = new Event("click");
  $(el, "a").dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
});

test("a link that is not http(s) is not clickable", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  const el = filePreview({ kind: "link_preview", url: "javascript:alert(1)", title: "Click me" }, {});
  assert.equal($(el, "a"), null);
  assert.equal($(el, "button"), null);
});

test("a link still loading shows the raw URL with a skeleton until the title arrives, then swaps in place", () => {
  const el = filePreview({ kind: "link_preview", url: "https://harlow.example/a", loading: true }, {});
  assert.match(text(el), /https:\/\/harlow\.example\/a/);
  assert.ok($(el, ".cv-fp-skel"));
  el.update({ kind: "link_preview", url: "https://harlow.example/a", title: "Harlow intake form" });
  assert.match(text(el), /Harlow intake form/);
  assert.equal($(el, ".cv-fp-skel"), null);
});

test("a missing file says so, keeps its name, and is not a control", () => {
  const el = filePreview({ ...FILE, missing: true }, { open: () => assert.fail("opened") });
  assert.match(text(el), /Harlow-report\.pdf/);
  assert.match(text(el), /No longer available/);
  assert.equal($(el, "button"), null);
  assert.equal($(el, "a"), null);
  assert.ok($(el, ".cv-fp-gone"));
});

test("a thumbnail is drawn only when it is on this box or inline, never a third party's", () => {
  assert.equal(safeThumb("/thumbs/a1.png"), "/thumbs/a1.png");
  assert.ok(safeThumb("data:image/png;base64,AAAA"));
  assert.equal(safeThumb("https://tracker.example/x.png"), null);
  assert.equal(safeThumb("//tracker.example/x.png"), null);
  assert.equal(safeThumb("data:image/svg+xml;base64,AAAA"), null);
  const with_ = filePreview({ ...FILE, thumb: "/thumbs/a1.png" }, {});
  assert.equal($(with_, "img").getAttribute("src"), "/thumbs/a1.png");
  const without = filePreview({ ...FILE, thumb: "https://tracker.example/x.png" }, {});
  assert.equal($(without, "img"), null);
});

test("text from an agent stays text: a name that looks like markup is a text node", () => {
  const el = filePreview({ kind: "file_preview", name: "<img src=x onerror=alert(1)>.md", path: "x.md" }, {});
  assert.equal($(el, "img"), null);
  assert.match(text(el), /<img src=x/);
});

test("sizeLabel", () => {
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(999), "999 B");
  assert.equal(sizeLabel(1500), "2 KB");
  assert.equal(sizeLabel(12_400_000), "12 MB");
  assert.equal(sizeLabel("x"), "");
});

test("previewRow draws several chips in one wrapping row", () => {
  const row = previewRow([FILE, { kind: "file_preview", path: "src/menu/PriceList.js" }, { kind: "link_preview", url: "https://harlow.example", title: "Harlow" }], {});
  assert.equal($$(row, ".cv-fp").length, 3);
});

test("previewsIn splits prose into text and previews, in order", () => {
  const p = previewsIn("I put it in `reports/q3.pdf` and linked [the Harlow brief](https://harlow.example/brief). Done.");
  assert.deepEqual(p.map(x => ("text" in x ? "t" : x.preview.kind)), ["t", "file_preview", "t", "link_preview", "t"]);
  assert.equal(/** @type {any} */ (p[1]).preview.name, "q3.pdf");
  assert.equal(/** @type {any} */ (p[3]).preview.title, "the Harlow brief");
  assert.equal(p.map(x => ("text" in x ? x.text : "")).join(""), "I put it in  and linked . Done.");
});

test("previewsIn leaves plain code, non-file code and non-http links alone", () => {
  assert.deepEqual(previewsIn("run `npm test` now"), [{ text: "run `npm test` now" }]);
  assert.deepEqual(previewsIn("see [x](javascript:alert(1))"), [{ text: "see [x](javascript:alert(1))" }]);
  assert.deepEqual(previewsIn(""), []);
});
