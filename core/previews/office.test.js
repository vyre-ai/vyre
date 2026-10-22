// @ts-check
// A Word, Excel or PowerPoint file served by the preview is a page of its text. A script in the file stays text.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import PizZip from "pizzip";
import { createStatic } from "./static.js";
import { officeHtml } from "./office.js";
import { docx } from "../documents/testing/docx.js";

const NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** @param {string} inner the escaped text of one run */
function hostileDocx(inner) {
  const z = new PizZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>`);
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="${NS}"><w:body><w:p><w:r><w:t>${inner}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generate({ type: "nodebuffer" });
}

/** @param {string} cell */
function xlsx(cell) {
  const z = new PizZip();
  z.file("xl/sharedStrings.xml", `<?xml version="1.0"?><sst><si><t>${cell}</t></si></sst>`);
  z.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet><sheetData></sheetData></worksheet>`);
  return z.generate({ type: "nodebuffer" });
}

/** @param {string} slide */
function pptx(slide) {
  const z = new PizZip();
  z.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld><p:sp><a:t>${slide}</a:t></p:sp></p:sld>`);
  return z.generate({ type: "nodebuffer" });
}

/** @param {number} port @param {string} urlPath */
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { "x-forwarded-host": "pv-abcd1234.preview.test" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), body }));
    });
    req.on("error", reject);
  });
}

test("Word, Excel and PowerPoint open through the preview as a page of their text, and a script stays text", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostile = hostileDocx("&lt;script&gt;alert(1)&lt;/script&gt;");
  fs.writeFileSync(path.join(dir, "note.docx"), docx(["North filing brief"]));
  fs.writeFileSync(path.join(dir, "sheet.xlsx"), xlsx("North totals"));
  fs.writeFileSync(path.join(dir, "deck.pptx"), pptx("North slide"));
  fs.writeFileSync(path.join(dir, "hostile.docx"), hostile);

  for (const [file, ext, needle] of /** @type {[string, string, string][]} */ ([["note.docx", ".docx", "North filing brief"], ["sheet.xlsx", ".xlsx", "North totals"], ["deck.pptx", ".pptx", "North slide"]])) {
    const html = officeHtml(fs.readFileSync(path.join(dir, file)), ext);
    assert.match(html, new RegExp(needle));
    assert.equal(html.includes("<script"), false, file);
  }
  const bad = officeHtml(hostile, ".docx");
  assert.match(bad, /alert\(1\)/);
  assert.equal(bad.includes("<script"), false);

  const srv = createStatic({
    lookup: (id) => (id === "abcd1234" ? { root: dir, file: null, caps: false } : null),
    drawn: async () => "",
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => srv.close());
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("the preview did not bind");
  for (const [file, needle] of /** @type {[string, string][]} */ ([["note.docx", "North filing brief"], ["sheet.xlsx", "North totals"], ["deck.pptx", "North slide"], ["hostile.docx", "alert(1)"]])) {
    const res = /** @type {{ status?: number, type: string, body: string }} */ (await get(addr.port, `/${file}`));
    assert.equal(res.status, 200, file);
    assert.match(res.type, /text\/html/);
    assert.match(res.body, new RegExp(needle.replace(/[()]/g, "\\$&")));
    assert.equal(res.body.includes("<script"), false, file);
  }
});
