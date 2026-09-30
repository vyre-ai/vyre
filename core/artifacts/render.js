// @ts-check
// What an artifact is on disk, and how its content becomes a page someone opens. Pure: no store,
// no events, no tools. Used for the private content route (the web app frames it) and the public
// snapshot (the share server serves it). Both run at an opaque origin: the CSP below carries
// `sandbox`, so even a page opened directly never gets the address's cookies or passkey session,
// can't set a cookie, and can't reach the box or the internet (plans/artifacts.md 3.4, AR2/AR3).
//
// The drawing of docs, decks, diagrams and dashboards here is the plain first version: escaped
// Markdown, an SVG shown only as an image, Mermaid and chart specs as their source and a table.
// app-design's renderers replace these looks; the security rules stay.

/** @typedef {"doc"|"report"|"page"|"dashboard"|"diagram"|"deck"|"app"} Kind */
/** @typedef {"markdown"|"html"|"mermaid"|"svg"|"chart"|"slides"} Format */

/** Which formats each kind takes; the first is its default. @type {Record<Kind, Format[]>} */
export const KINDS = {
  doc: ["markdown"], report: ["markdown"], deck: ["slides", "markdown"],
  page: ["html"], app: ["html"], diagram: ["mermaid", "svg"], dashboard: ["chart"],
};

/** The file an artifact of a format keeps its content in. @type {Record<Format, string>} */
export const MAIN_FILE = { markdown: "index.md", slides: "slides.md", html: "index.html", mermaid: "diagram.mmd", svg: "diagram.svg", chart: "chart.json" };
/** A dashboard's data, beside its chart spec. */
export const DATA_FILE = "data.json";

/** Per version, content plus data. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** A file saved in a thread's artifacts folder, by extension, becomes this kind and format. */
export const BY_EXTENSION = /** @type {Record<string, {kind: Kind, format: Format}>} */ ({
  ".md": { kind: "doc", format: "markdown" }, ".markdown": { kind: "doc", format: "markdown" },
  ".html": { kind: "page", format: "html" }, ".htm": { kind: "page", format: "html" },
  ".mmd": { kind: "diagram", format: "mermaid" }, ".svg": { kind: "diagram", format: "svg" },
});

/** Everything an artifact's page may do: draw itself. Nothing from the network, no forms, no
 * navigation of anything but itself, no plugins, and an opaque origin even at the top level. */
const BASE = [
  "default-src 'none'", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:", "media-src data: blob:",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "worker-src 'none'", "manifest-src 'none'",
];

/**
 * The response headers for an artifact's page.
 * @param {{ scripts: boolean, framedBy: "self" | "none" }} o scripts: only a page or an app runs its
 *   own script; framedBy: the web app frames the private view, nobody frames a public one.
 * @returns {Record<string,string>}
 */
export function pageHeaders({ scripts, framedBy }) {
  const csp = [scripts ? "sandbox allow-scripts" : "sandbox", ...BASE, scripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    `frame-ancestors ${framedBy === "self" ? "'self'" : "'none'"}`].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
    "cache-control": "no-store",
    ...(framedBy === "none" ? { "x-frame-options": "DENY", "x-robots-tag": "noindex, nofollow" } : {}),
  };
}

const ESC = /** @type {Record<string,string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });
/** @param {string} s */
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

/** Inline Markdown on already-escaped text: code, bold, italic, and http(s) links. @param {string} s */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)&"]+)\)/g, '<a href="$2" rel="noopener noreferrer nofollow" target="_blank">$1</a>');
}

/**
 * Markdown to HTML, escape first: nothing the author wrote is ever read as markup. Headings,
 * paragraphs, lists, fenced code, quotes, rules and pipe tables.
 * @param {string} md
 */
export function markdown(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (/** @type {string} */ r) => r.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(inline(lines[i].replace(/^>\s?/, "")));
      out.push(`<blockquote>${q.join("<br>")}</blockquote>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const p = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*(?:[-*+]|\d+\.)\s|\s*\|)/.test(lines[i]); i++) p.push(inline(lines[i]));
    if (!p.length) { out.push(`<p>${inline(l)}</p>`); i++; continue; }
    out.push(`<p>${p.join("<br>")}</p>`);
  }
  return out.join("\n");
}

const STYLE = `:root{color-scheme:light dark;--bg:#F4F1EA;--text:#141311;--text2:#4A463F;--rule:#DCD7CC;--code:#F0EDE5}
@media (prefers-color-scheme:dark){:root{--bg:#0E0D0C;--text:#F1EEE6;--text2:#B3AEA4;--rule:#2B2926;--code:#121110}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/22px -apple-system,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:820px;margin:0 auto;padding:32px 16px 64px}h1,h2,h3{line-height:1.25}a{color:inherit}
pre,code{font:13px/18px ui-monospace,Menlo,monospace;background:var(--code);border-radius:4px}pre{padding:12px;overflow:auto}code{padding:1px 4px}pre code{padding:0}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--rule);padding:6px 8px;text-align:left}
blockquote{margin:0;padding-left:12px;border-left:3px solid var(--rule);color:var(--text2)}hr{border:0;border-top:1px solid var(--rule)}
section.slide{border:1px solid var(--rule);border-radius:12px;padding:24px;margin:0 0 16px}img.svg{max-width:100%;height:auto}`;

/** The network ban a page carries itself, for a copy opened with no server headers (a download).
 * A meta tag can't set `sandbox`, but it does stop every request out. @param {string} html */
export function withMetaCsp(html) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${BASE.join("; ")}; script-src 'unsafe-inline'">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}<head>${tag}</head>${html.slice(doctype[0].length)}`;
  return `<!doctype html><head>${tag}</head>${html}`;
}

/** @param {string} title @param {string} body */
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

/**
 * An artifact's content as one page. For html it is the author's own page, unchanged (its
 * headers are what keep it in its box); for every other format it is built here, escaped.
 * @param {{ title: string, format: Format, files: Record<string,string> }} a
 * @returns {{ html: string, scripts: boolean }}
 */
export function page({ title, format, files }) {
  const main = files[MAIN_FILE[format]] || "";
  if (format === "html") return { html: main, scripts: true };
  if (format === "markdown") return { html: shell(title, markdown(main)), scripts: false };
  if (format === "slides") {
    const slides = main.split(/\n-{3,}\n/).map(s => `<section class="slide">${markdown(s)}</section>`).join("");
    return { html: shell(title, slides), scripts: false };
  }
  if (format === "svg") {
    // Only ever an image: an SVG drawn by <img> runs no script and loads nothing.
    const src = `data:image/svg+xml;base64,${Buffer.from(main, "utf8").toString("base64")}`;
    return { html: shell(title, `<h1>${esc(title)}</h1><img class="svg" alt="${esc(title)}" src="${src}">`), scripts: false };
  }
  if (format === "mermaid") return { html: shell(title, `<h1>${esc(title)}</h1><pre><code>${esc(main)}</code></pre>`), scripts: false };
  // chart: the data as a table under its title, until the chart renderer lands.
  let rows = [];
  try { const d = JSON.parse(files[DATA_FILE] || "[]"); rows = Array.isArray(d) ? d : Array.isArray(d.rows) ? d.rows : []; } catch {}
  const cols = rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).slice(0, 12) : [];
  const table = cols.length ? `<table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, 500).map(r => `<tr>${cols.map(c => `<td>${esc(r && r[c] != null ? String(r[c]) : "")}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "<p>No data yet.</p>";
  return { html: shell(title, `<h1>${esc(title)}</h1>${table}`), scripts: false };
}

/** Title from content when none was given: the first Markdown heading, the HTML title, or null. @param {string} text */
export function titleOf(text) {
  const h = /^#{1,3}\s+(.+)$/m.exec(text);
  if (h) return h[1].trim().slice(0, 120);
  const t = /<title>([^<]{1,120})<\/title>/i.exec(text);
  return t ? t[1].trim() : null;
}
