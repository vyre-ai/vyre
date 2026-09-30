// @ts-check
// File and link preview (docs/design/system/components/file-preview.md): one compact inline row
// for a file an agent touched or a link it found. Icon or thumbnail, a name, one meta line.
// Not a card: no panel, no border until hover, 40 tall, capped at 320 wide.
//
//   { kind: "file_preview", name, path, size?, mime?, thumb?, lines?, missing? }
//   { kind: "link_preview", url, title?, thumb?, loading?, missing? }
//
// (`kind` is the render kind that index.js's DISPLAY picks by; a file's own type is read from
// `mime`, else the name's extension.) A tap opens through ctx.open(href): a file by its path, a
// link by its URL. The row never fetches anything: a thumbnail is drawn only when it is a path on
// this box or an inline image, so the person's browser never reaches a third party on render.

import { h } from "../../js/dom.js";
import { icon } from "../../js/icons.js";
import { ensureCss } from "./kit.js";

const MAX_NAME = 120;
/** File types the meta line names, by extension. Anything else shows the extension in capitals. */
const TYPES = { pdf: "PDF", md: "Markdown", txt: "Text", csv: "CSV", json: "JSON", png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP", svg: "SVG",
  doc: "Word", docx: "Word", xls: "Excel", xlsx: "Excel", ppt: "PowerPoint", pptx: "PowerPoint", zip: "Zip", js: "JavaScript", ts: "TypeScript", html: "HTML" };
const MIMES = { "application/pdf": "PDF", "text/markdown": "Markdown", "text/plain": "Text", "text/csv": "CSV", "application/json": "JSON",
  "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP", "image/svg+xml": "SVG", "application/zip": "Zip" };

/** http and https only: a preview never links to javascript: or data: pages. @param {any} u @returns {string|null} */
export function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch { return null; }
}

/** A thumbnail the row may draw: a path on this box, or an inline image. @param {any} t @returns {string|null} */
export function safeThumb(t) {
  const s = String(t || "");
  return (/^\/(?!\/)/.test(s) || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : null;
}

/** "2.1 MB", "340 KB", "812 B". @param {any} n */
export function sizeLabel(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return "";
  if (b < 1000) return `${Math.round(b)} B`;
  if (b < 1e6) return `${Math.round(b / 1e3)} KB`;
  const mb = b / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const extOf = (/** @type {string} */ name) => (String(name).match(/\.([A-Za-z0-9]{1,6})$/)?.[1] || "").toLowerCase();
const nameOf = (/** @type {string} */ p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");

/** The domain of a link, without "www.". @param {string} url */
export function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }

/** What the row shows for a payload: name, meta line, label, and where a tap goes. @param {any} d */
export function describe(d) {
  const link = d?.kind === "link_preview" || (!d?.path && !!d?.url);
  const missing = !!d?.missing || !!d?.broken;
  if (link) {
    const url = safeUrl(d.url);
    const domain = url ? domainOf(url) : "";
    // A link whose title has not resolved yet shows the raw URL until it does.
    const name = String(d.title || d.name || (d.loading ? d.url : domain) || d.url || "Link").slice(0, MAX_NAME);
    const meta = missing ? "No longer available" : domain;
    return { link: true, missing, loading: !!d.loading && !d.title, name, meta, href: url, thumb: safeThumb(d.thumb), label: `${name}, ${meta || "link"}` };
  }
  const name = String(d?.name || nameOf(d?.path) || "File").slice(0, MAX_NAME);
  const type = MIMES[String(d?.mime || "")] || TYPES[extOf(name)] || extOf(name).toUpperCase();
  const parts = missing ? ["No longer available"] : [sizeLabel(d?.size), type, Number.isFinite(Number(d?.lines)) && d?.lines != null ? `${Number(d.lines).toLocaleString("en-US")} lines` : ""].filter(Boolean);
  const meta = parts.join(" · ");
  return { link: false, missing, loading: false, name, meta, href: typeof d?.path === "string" ? d.path : null, thumb: missing ? null : safeThumb(d?.thumb), label: meta ? `${name}, ${meta}` : name };
}

/**
 * One preview chip. .update(data) redraws in place.
 * @param {any} data @param {any} [ctx]
 * @returns {HTMLElement & { update: (d: any) => void }}
 */
export function filePreview(data, ctx = {}) {
  ensureCss("file-preview");
  const el = /** @type {any} */ (h("span", { class: "cv-fp" }));
  el._kind = "card";
  el._ts = null;
  const open = (/** @type {string} */ href) => (ctx.open ? ctx.open(href) : undefined);
  el.update = (/** @type {any} */ d) => {
    data = d;
    const v = describe(d);
    const glyph = v.thumb
      ? h("img", { class: "cv-fp-thumb", src: v.thumb, alt: "", width: "24", height: "24", loading: "lazy", referrerpolicy: "no-referrer" })
      : v.loading ? h("span", { class: "cv-fp-skel", "aria-hidden": "true" })
      : h("span", { class: "cv-fp-ico" + (v.missing ? " cv-fp-gone" : ""), "aria-hidden": "true" }, icon(v.link && !v.missing ? "login" : "file", 20));
    const body = [glyph, h("span", { class: "cv-fp-name ellipsis" }, v.name), v.meta ? h("span", { class: "cv-fp-meta ellipsis" }, v.meta) : null];
    // A link is a real anchor (new tab, no opener); a file is a button that asks ctx.open. Neither
    // is a div with a click handler, and a missing file is not a dead control: it stays a plain row.
    let row;
    if (v.missing) row = h("span", { class: "cv-fp-row cv-fp-broken", role: "text", "aria-label": v.label }, body);
    else if (v.link && v.href) {
      const href = v.href;
      row = h("a", { class: "cv-fp-row", href, target: "_blank", rel: "noopener noreferrer", "aria-label": v.label,
        onclick: (/** @type {Event} */ e) => { if (ctx.open) { e.preventDefault(); open(href); } } }, body);
    } else if (v.href) {
      const href = v.href;
      row = h("button", { class: "cv-fp-row", type: "button", "aria-label": v.label, onclick: () => open(href) }, body);
    } else row = h("span", { class: "cv-fp-row", "aria-label": v.label }, body);
    el.replaceChildren(row);
  };
  el.update(data);
  return el;
}

/** Several previews from one message as a wrapping row of chips, gap 8. @param {any[]} items @param {any} [ctx] */
export function previewRow(items, ctx = {}) {
  ensureCss("file-preview");
  return h("span", { class: "cv-fp-list" }, (items || []).map(d => filePreview(d, ctx)));
}

/**
 * Inline previews found in a line of prose, so lib/markdown's users can adopt them: a Markdown
 * link with an http(s) address becomes a link_preview, and a backticked path with a file
 * extension (`reports/q3.pdf`) becomes a file_preview. Returns the text in order as pieces,
 * `{ text }` or `{ preview }`; a caller draws previews with filePreview() (or previewRow() when
 * several sit together) and the rest as it draws text today. Nothing is fetched here.
 * @param {string} text @returns {({ text: string } | { preview: any })[]}
 */
export function previewsIn(text) {
  const src = String(text ?? "");
  const re = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)|`((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,6})`/g;
  /** @type {({ text: string } | { preview: any })[]} */ const out = [];
  let last = 0, m;
  while ((m = re.exec(src))) {
    const preview = m[2]
      ? (safeUrl(m[2]) ? { kind: "link_preview", url: m[2], title: m[1] } : null)
      : { kind: "file_preview", path: m[3], name: nameOf(m[3]) };
    if (!preview) continue;
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    out.push({ preview });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}
