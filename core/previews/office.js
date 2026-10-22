// @ts-check
// A Word, Excel or PowerPoint file as a plain page: the text of the document, nothing that can run.
// The preview server (static.js) sends this instead of the raw zip. The app's viewer draws the same kinds itself.
import PizZip from "pizzip";

const OFFICE = new Set([".docx", ".xlsx", ".pptx"]);

/** @param {string} ext */
export const isOffice = (ext) => OFFICE.has(String(ext).toLowerCase());

/** @param {string} s */
function unescapeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {string} xml @param {RegExp} re @param {string[]} out */
function take(xml, re, out) {
  for (const m of xml.matchAll(re)) out.push(unescapeXml(m[1]));
}

/**
 * The file's text as a page. Tags in the text are escaped, so a script in a cell is text.
 * @param {Buffer | Uint8Array} buf @param {string} ext
 */
export function officeHtml(buf, ext) {
  const z = new PizZip(buf);
  /** @type {string[]} */ const texts = [];
  const e = String(ext).toLowerCase();
  if (e === ".docx") {
    const f = z.file("word/document.xml");
    if (f) take(String(f.asText()), /<w:t[^>]*>([^<]*)<\/w:t>/g, texts);
  } else if (e === ".xlsx") {
    for (const name of Object.keys(z.files)) {
      if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
      const f = z.file(name);
      if (f) take(String(f.asText()), /<t[^>]*>([^<]*)<\/t>/g, texts);
    }
  } else if (e === ".pptx") {
    for (const name of Object.keys(z.files)) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      const f = z.file(name);
      if (f) take(String(f.asText()), /<a:t[^>]*>([^<]*)<\/a:t>/g, texts);
    }
  }
  const body = texts.map((t) => `<p>${escapeHtml(t)}</p>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Preview</title><body>${body}</body>`;
}
