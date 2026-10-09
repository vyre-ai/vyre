// @ts-check
// pdf: a filled .docx to a PDF through Gotenberg (MIT), the converter that runs beside Vyre. It is addressed by `documents.pdf` in config (its address, such as http://127.0.0.1:3000); nothing is
// sent anywhere else. With none set, a PDF is refused in plain words and the .docx is still made.
import crypto from "node:crypto";
import { userHostFetch } from "../../lib/http.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
export const PDF_MAX = 40 * 1024 * 1024;

/** One multipart/form-data body with one file part. @param {string} field @param {string} filename @param {Buffer} bytes @param {string} type */
export function multipart(field, filename, bytes, type) {
  const boundary = "----vyre" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"\r\nContent-Type: ${type}\r\n\r\n`);
  return { boundary, body: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

/**
 * @param {Buffer} docx @param {{ url?: string, fetch?: typeof fetch }} o
 * @returns {Promise<Buffer>}
 */
export async function toPdf(docx, o) {
  let base;
  try { base = o.url ? new URL(o.url) : null; } catch { base = null; }
  if (!base || !/^https?:$/.test(base.protocol)) throw fail("no_pdf_engine", "a PDF needs the converter: set documents.pdf in config.json to its address (Gotenberg), or ask for the Word file");
  const { boundary, body } = multipart("files", "document.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const doFetch = o.fetch || userHostFetch;
  let res;
  try { res = await doFetch(new URL("/forms/libreoffice/convert", base).href, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body, signal: AbortSignal.timeout(120_000) }); }
  catch (e) { throw fail("pdf_unreachable", `the PDF converter did not answer (${String(/** @type {Error} */ (e).message).slice(0, 120)})`); }
  if (!res.ok) throw fail("pdf_failed", `the PDF converter refused the document (HTTP ${res.status})`);
  const out = Buffer.from(await res.arrayBuffer());
  if (!out.length || out.length > PDF_MAX || out.subarray(0, 4).toString() !== "%PDF") throw fail("pdf_failed", "the PDF converter did not answer with a PDF");
  return out;
}
