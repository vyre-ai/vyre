// @ts-check
// mime: just enough of RFC 2045 and 2046 to read a message as plain text. It walks multipart
// bodies for the first text/plain part that is not an attachment, and falls back to the first
// text/html part with its tags stripped. Quoted-printable and base64 are decoded, and so is the
// charset. Attachments are named, never decoded.

import { decodeWords, decodeCharset } from "./imap.js";

const CAP = 20_000;

/** Headers and body of one entity. @param {Buffer} raw */
function split(raw) {
  let i = raw.indexOf("\r\n\r\n"), gap = 4;
  const lf = raw.indexOf("\n\n");
  if (i < 0 || (lf >= 0 && lf < i)) { i = lf; gap = 2; }
  const head = (i < 0 ? raw : raw.subarray(0, i)).toString("latin1");
  const body = i < 0 ? Buffer.alloc(0) : raw.subarray(i + gap);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    // Header bytes are often UTF-8 even though they should be ASCII.
    const v = Buffer.from(m[2], "latin1").toString("utf8").trim();
    if (!(k in headers)) headers[k] = v;
  }
  return { headers, body };
}

/** "text/plain; charset=utf-8; name=x" to a type and its parameters. @param {string} [v] */
export function contentType(v = "text/plain") {
  const [type, ...rest] = String(v).split(";");
  /** @type {Record<string, string>} */
  const params = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|([^\s;]*))/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return { type: type.trim().toLowerCase() || "text/plain", params };
}

/** @param {Buffer} body @param {string} [cte] */
function decodeBody(body, cte = "") {
  const e = cte.trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") {
    const s = body.toString("latin1").replace(/=\r?\n/g, "");
    return Buffer.from(s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  }
  return body;
}

/** Tags out, entities decoded, blank lines collapsed. @param {string} html */
export function stripHtml(html) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(html)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return named[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Walk an entity: the plain text part, the html part, and attachment names.
 * @param {Buffer} raw @param {number} depth
 * @returns {{ plain?: string, html?: string, attachments: string[] }}
 */
function walk(raw, depth = 0) {
  const { headers, body } = split(raw);
  const ct = contentType(headers["content-type"]);
  const disposition = String(headers["content-disposition"] || "").toLowerCase();
  const out = { attachments: /** @type {string[]} */ ([]) };
  if (ct.type.startsWith("multipart/") && ct.params.boundary && depth < 10) {
    const b = Buffer.from("--" + ct.params.boundary);
    const pieces = [];
    let at = body.indexOf(b);
    while (at >= 0) {
      const start = body.indexOf("\n", at);
      if (start < 0) break;
      const next = body.indexOf(b, start);
      if (next < 0) break;
      let end = next;
      if (body[end - 1] === 10) end--;
      if (body[end - 1] === 13) end--;
      pieces.push(body.subarray(start + 1, end));
      if (body.subarray(next + b.length, next + b.length + 2).toString() === "--") break;
      at = next;
    }
    for (const p of pieces) {
      const sub = walk(p, depth + 1);
      if (sub.plain !== undefined && out.plain === undefined) out.plain = sub.plain;
      if (sub.html !== undefined && out.html === undefined) out.html = sub.html;
      out.attachments.push(...sub.attachments);
    }
    return out;
  }
  const name = /filename\*?=/.test(disposition) || disposition.startsWith("attachment") || ct.params.name;
  if (name && (disposition.startsWith("attachment") || !ct.type.startsWith("text/"))) {
    const n = /filename="?([^";]+)"?/i.exec(headers["content-disposition"] || "")?.[1] || ct.params.name || "attachment";
    out.attachments.push(decodeWords(n));
    return out;
  }
  if (ct.type === "text/plain") out.plain = decodeCharset(decodeBody(body, headers["content-transfer-encoding"]), ct.params.charset);
  else if (ct.type === "text/html") out.html = decodeCharset(decodeBody(body, headers["content-transfer-encoding"]), ct.params.charset);
  return out;
}

/**
 * A whole message as headers and plain text.
 * @param {Buffer} raw
 */
export function readMessage(raw) {
  const { headers } = split(raw);
  const w = walk(raw);
  let body = w.plain !== undefined ? w.plain : w.html !== undefined ? stripHtml(w.html) : "";
  body = body.replace(/\r\n/g, "\n");
  const truncated = body.length > CAP;
  const h = k => decodeWords(headers[k] || "");
  return {
    from: h("from"), to: h("to"), ...(headers.cc ? { cc: h("cc") } : {}), subject: h("subject"), date: headers.date || "",
    message_id: headers["message-id"] || "", ...(headers.references ? { references: headers.references } : {}),
    body: truncated ? body.slice(0, CAP) : body, ...(truncated ? { truncated: true } : {}),
    format: w.plain !== undefined ? "text" : w.html !== undefined ? "html" : "none",
    ...(w.attachments.length ? { attachments: w.attachments } : {}),
  };
}
