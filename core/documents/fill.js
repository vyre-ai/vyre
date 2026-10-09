// @ts-check
// fill: the pure half of Documents (R032-01). A Word template with {placeholders} in, a filled .docx out, from a plain values object. Deterministic: the same template and values give the same bytes
// (every entry of the zip carries one fixed date), and a value that is missing STOPS the document and names itself; nothing is guessed, defaulted or left blank.
//
// Placeholders: {client.name} reads client -> name; {#items}{label}{/items} repeats; {matter.fee} is a number or text as the record holds it. A value is missing when it is undefined, null or an empty
// string; 0 and false are values.

import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

/** One date for every entry, so the same input is the same bytes. */
const FIXED = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
/** The most a template may weigh and the most entries it may hold (a bomb is refused before it is read). */
export const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_UNPACKED = 80 * 1024 * 1024;

/** An error with a code the registry passes through. */
const fail = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ more = {}) => Object.assign(new Error(message), { code }, more);

/** The value of a path like "client.name" or "items.0.label" in the scope stack, innermost first; undefined when any step is not there. @param {any[]} scopes @param {string} path */
function lookup(scopes, path) {
  const parts = path.split(".");
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (s == null || typeof s !== "object" || !Object.prototype.hasOwnProperty.call(s, parts[0])) continue;
    let v = s;
    for (const p of parts) {
      if (v == null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, p)) return undefined;
      v = v[p];
    }
    return v;
  }
  return undefined;
}

/** The parser docxtemplater asks for: dotted paths, and `.` for the current item of a loop. @param {string} tag */
function parser(tag) {
  const t = tag.trim();
  return { get: (/** @type {any} */ scope, /** @type {any} */ ctx) => (t === "." ? scope : lookup(ctx && ctx.scopeList ? ctx.scopeList : [scope], t)) };
}

/** Open a .docx safely. @param {Buffer} buf */
function open(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail("bad_input", "the template is empty");
  if (buf.length > MAX_BYTES) throw fail("too_big", `the template is ${buf.length} bytes; the most is ${MAX_BYTES}`);
  /** @type {any} */ let zip;
  try { zip = new PizZip(buf); } catch { throw fail("bad_template", "that is not a Word (.docx) file"); }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw fail("bad_template", "that .docx holds too many parts");
  if (!zip.file("word/document.xml")) throw fail("bad_template", "that is not a Word (.docx) file: it has no word/document.xml");
  let total = 0;
  for (const n of names) total += (zip.files[n]._data && zip.files[n]._data.uncompressedSize) || 0;
  if (total > MAX_UNPACKED) throw fail("too_big", "that .docx unpacks to more than it may");
  return zip;
}

/** The text of every part that can hold a placeholder, tags stripped so a placeholder Word split across runs reads whole. @param {any} zip */
function plainText(zip) {
  return Object.keys(zip.files).filter(n => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n)).map(n => String(zip.file(n).asText()).replace(/<w:p[ >]/g, "\n<w:p ").replace(/<[^>]+>/g, "")).join("\n");
}

/**
 * The names a template asks for, in the order they first appear: { names: ["client.name", ...], loops: ["items"], loopFields: { items: ["label"] } }. The fields of a loop belong to the loop.
 * @param {Buffer} buf
 */
export function placeholders(buf) {
  const zip = open(buf);
  /** @type {any} */ let doc;
  try { doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, parser, delimiters: { start: "{", end: "}" } }); }
  catch (e) { throw templateError(e); }
  const loops = [...new Set([...plainText(zip).matchAll(/\{[#^]\s*([A-Za-z0-9_.]+)\s*\}/g)].map(m => m[1]))];
  /** @type {Set<string>} */ const names = new Set();
  /** @type {Record<string, string[]>} */ const loopFields = {};
  const walk = (/** @type {any} */ node, /** @type {string} */ prefix) => {
    for (const [k, v] of Object.entries(node || {})) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && Object.keys(v).length) {
        // A loop's own fields belong to the loop (listed under it), not to the document.
        if (loops.includes(full)) loopFields[full] = Object.keys(v); else walk(v, full);
      } else if (!loops.includes(full)) names.add(full);
    }
  };
  // getTags() answers per part of the file: { document: { tags, target }, header1: { ... } }.
  for (const part of Object.values(doc.getTags() || {})) walk(part && /** @type {any} */ (part).tags, "");
  return { names: [...names], loops, loopFields };
}

/** A template that will not compile, said in plain words: where Word split a tag, the tag. @param {any} e */
function templateError(e) {
  const list = e && e.properties && Array.isArray(e.properties.errors) ? e.properties.errors : [];
  const said = list.map((/** @type {any} */ x) => String(x && x.properties && (x.properties.explanation || x.properties.id) || x.message || "").slice(0, 200)).filter(Boolean).slice(0, 4);
  return fail("bad_template", `the template has a placeholder that cannot be read${said.length ? ": " + said.join("; ") : ""}`);
}

/**
 * Fill a template. Every placeholder must have a value: otherwise nothing is made and the error names each missing one.
 * @param {Buffer} buf the .docx @param {Record<string, any>} values @returns {{ buffer: Buffer, used: string[] }}
 */
export function fill(buf, values) {
  const zip = open(buf);
  /** @type {Set<string>} */ const missing = new Set();
  /** @type {any} */ let doc;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true, linebreaks: true, parser, delimiters: { start: "{", end: "}" },
      // Called for any placeholder whose value is undefined or null; the document is refused below, whatever this returns.
      nullGetter: (/** @type {any} */ part) => { missing.add(String(part && part.value || "?")); return ""; },
    });
  } catch (e) { throw templateError(e); }
  try { doc.render(values && typeof values === "object" ? values : {}); }
  catch (e) { if (!missing.size) throw templateError(e); }
  // A blank is missing too (an empty string in a legal paper is a mistake), and so is a loop with no list to repeat: docxtemplater renders nothing for either without asking.
  const { names: tags, loops } = placeholders(buf);
  for (const n of tags) { if (!n.includes(".") || !loops.some(l => n.startsWith(l + "."))) { const v = lookup([values || {}], n); if (v === "") missing.add(n); } }
  for (const l of loops) { const v = lookup([values || {}], l); if (v === undefined || v === null || v === "") missing.add(l); }
  if (missing.size) {
    const list = [...missing].sort();
    throw fail("missing_values", `the document was not made: ${list.length === 1 ? "this value is" : "these values are"} missing: ${list.join(", ")}`, { missing: list });
  }
  const out = doc.getZip();
  for (const n of Object.keys(out.files)) out.files[n].date = FIXED;
  return { buffer: out.generate({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }), used: tags };
}
