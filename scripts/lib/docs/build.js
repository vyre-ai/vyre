// @ts-check
// docs.vyre.run, built: every page in docs/nav.json rendered to HTML, its source beside it as
// .md, and the files agents and Cloudflare Pages read.
//
//   <out>/index.html, using/capsule.html, ...   the pages (see load.js for the URL scheme)
//   <out>/index.md, using/capsule.md, ...       each page's source, front matter kept, includes spliced
//   <out>/assets/docs.<hash>.css, .js           one stylesheet, one script, named by content hash
//   <out>/search-index.json                     what the search box searches, offline once loaded
//   <out>/llms.txt, llms-full.txt               the llms.txt convention: an index, and everything
//   <out>/sitemap.xml, robots.txt, 404.html, favicon.svg
//   <out>/_redirects                            a 301 for every moved page, pretty and .md
//   <out>/_headers                              content types for .md and .txt, cache rules
//
// Deterministic: the same tree builds the same bytes. Nothing reads the clock or the network, and
// every list is in nav order or sorted.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOf, parseFrontMatter } from "./frontmatter.js";
import { decodeEntities, escapeHtml, renderMarkdown } from "./markdown.js";
import { isUnpublished, loadDocs, pageUrl, resolveDocLink } from "./load.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "assets");
const BODY_CHARS = 6000;

const FONTS = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

// The Lead mark and the wordmark, from docs/design/TOKENS.md. Colours come from CSS (.mk-*), so
// the one drawing is Bone and Signal on dark, Ink on paper.
const MARK = `<svg class="mark" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="mk-w" d="M3.5 5.5L12 19.5L17.96 9.69" stroke="#F1EEE6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle class="mk-d" cx="20.5" cy="5.5" r="2.3" fill="#C6F36B"/></svg>`;
const WORDMARK = `<svg class="wordmark" width="52" height="22" viewBox="-2 3 62 26" fill="none" aria-hidden="true"><path class="mk-w" d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="#F1EEE6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_MENU = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.5 5h13M2.5 9h13M2.5 13h13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_SEARCH = `<svg class="search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_SUN = `<svg class="i-sun" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_MOON = `<svg class="i-moon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

// Runs before first paint, so the page never flashes the wrong theme. Storage can throw (private
// windows, blocked site data); the system setting is the fallback, dark when it says nothing.
const THEME_BOOT = `(function(){var t;try{t=localStorage.getItem("vyre-docs-theme")}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)})();`;

/**
 * @param {{ root: string, out: string, log?: (msg: string) => void }} opts
 * @returns {{ pages: number, redirects: number, missing: string[], files: string[] }}
 */
export function build({ root, out, log = () => {} }) {
  const docs = loadDocs(root);
  const site = {
    title: docs.site.title || "Vyre docs",
    url: (docs.site.url || "https://docs.vyre.run").replace(/\/$/, ""),
    repo: (docs.site.repo || "https://github.com/vyre-ai/vyre").replace(/\/$/, ""),
    summary: docs.site.summary || packageDescription(root),
  };
  const docsDir = docs.docsDir;
  const byPath = new Map(docs.map(p => [p.path, p]));
  const redirectTo = new Map(docs.redirects.map(r => [r.from, r.to]));

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  /** @type {Map<string, string | Buffer>} */
  const files = new Map();
  const put = (/** @type {string} */ rel, /** @type {string | Buffer} */ data) => files.set(rel, data);

  // Assets, named by content.
  const css = fs.readFileSync(path.join(ASSETS, "docs.css"), "utf8");
  const js = fs.readFileSync(path.join(ASSETS, "docs.js"), "utf8");
  const cssName = `assets/docs.${hash(css)}.css`;
  const jsName = `assets/docs.${hash(js)}.js`;
  put(cssName, css);
  put(jsName, js);
  const favicon = path.join(root, "site", "favicon.svg");
  if (fs.existsSync(favicon)) put("favicon.svg", fs.readFileSync(favicon));
  const assets = { css: "/" + cssName, js: "/" + jsName };

  /** Files under docs/ that pages link to or show (images), copied as they are. */
  const copies = new Set();

  /** @param {string} href @param {string} base */
  const resolveLink = (href, base) => {
    const r = resolveDocLink(href, base);
    const frag = r.hash ? "#" + r.hash : "";
    if (r.kind === "external" || r.kind === "anchor" || r.kind === "absolute") return href;
    if (r.kind === "repo") return `${site.repo}/blob/main/${encodePath(r.path)}${frag}`;
    const p = r.path;
    if (p === "" || p.endsWith("/")) return `${site.repo}/tree/main/docs/${encodePath(p)}`;
    if (p.endsWith(".md")) {
      const page = byPath.get(p);
      if (page) return encodePath(page.url) + frag;
      const to = redirectTo.get(p);
      if (to) {
        const [tp, th] = to.split("#");
        return encodePath(pageUrl(tp)) + (frag || (th ? "#" + th : ""));
      }
      return `${site.repo}/blob/main/docs/${encodePath(p)}${frag}`;
    }
    const abs = path.join(docsDir, p);
    if (!isUnpublished(p, docs.unpublished) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      copies.add(p);
      return "/" + encodePath(p) + frag;
    }
    return `${site.repo}/blob/main/docs/${encodePath(p)}${frag}`;
  };

  /** @param {string} rel @param {string} base */
  const readInclude = (rel, base) => {
    const file = path.resolve(docsDir, base, rel);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) {
      log(`build-docs: include ${rel} (from docs/${base || "."}) not found, left out`);
      return null;
    }
    const text = parseFrontMatter(fs.readFileSync(file, "utf8")).body;
    return { text, base: path.posix.normalize(path.relative(docsDir, path.dirname(file)).split(path.sep).join("/")).replace(/^\.$/, "") };
  };

  const order = docs.slice();
  const nav = docs.sections.filter(s => s.pages.length);
  /** @type {any[]} */
  const index = [];
  const fullParts = [];

  for (let k = 0; k < order.length; k++) {
    const page = order[k];
    const base = path.posix.dirname(page.path).replace(/^\.$/, "");
    const r = renderMarkdown(page.body, { resolveLink, include: readInclude, base });
    const html = renderPage({ site, page, nav, prev: order[k - 1], next: order[k + 1], body: r.html, headings: r.headings, assets });
    put(page.htmlFile, html);

    const md = spliceIncludes(page.source, base, readInclude);
    put(page.path, md);

    index.push({
      t: page.title,
      u: page.url,
      s: page.section,
      d: page.summary,
      h: r.headings.filter(h => h.level >= 2 && h.level <= 3).map(h => [h.text, h.id]),
      b: plainText(r.html).slice(0, BODY_CHARS),
    });
    fullParts.push(`---\ntitle: ${page.title}\nurl: ${site.url}${page.mdUrl}\n---\n\n${parseFrontMatter(md).body.trim()}\n`);
  }

  for (const p of [...copies].sort()) put(p, fs.readFileSync(path.join(docsDir, p)));

  put("search-index.json", JSON.stringify(index));
  put("llms.txt", llmsTxt(site, nav));
  put("llms-full.txt", `# ${site.title}\n\n> ${site.summary}\n\n${fullParts.join("\n")}`);
  put("sitemap.xml", sitemap(site, order));
  put("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`);
  put("404.html", renderPage({
    site, page: null, nav, prev: undefined, next: undefined, assets, headings: [],
    body: `<h1>Not here</h1>\n<p>This page is not in the docs. It may have moved. Search above, press <kbd class="kbd">/</kbd>, or start from <a href="/">the docs home</a>.</p>`,
  }));

  const redirectLines = [];
  for (const rd of docs.redirects) {
    const [toPath, toHash] = rd.to.split("#");
    const frag = toHash ? "#" + toHash : "";
    redirectLines.push(`${encodePath(pageUrl(rd.from))} ${encodePath(pageUrl(toPath))}${frag} 301`);
    redirectLines.push(`/${encodePath(rd.from)} /${encodePath(toPath)} 301`);
  }
  put("_redirects", redirectLines.length ? redirectLines.join("\n") + "\n" : "");
  put("_headers", headers(order));

  const written = [...files.keys()].sort();
  for (const rel of written) {
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, /** @type {any} */ (files.get(rel)));
  }
  if (docs.missing.length) log(`build-docs: ${docs.missing.length} pages in nav.json do not exist yet, skipped: ${docs.missing.map(m => m.path).join(", ")}`);
  return { pages: order.length, redirects: docs.redirects.length, missing: docs.missing.map(m => m.path), files: written };
}

// ---- pieces ------------------------------------------------------------------------------------

/** @param {string} s */
function hash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 10);
}

/** @param {string} p */
function encodePath(p) {
  return p.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

/** @param {string} root */
function packageDescription(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).description || ""; } catch { return ""; }
}

/** Replace each include line outside fenced code with the file it names (front matter stripped). */
function spliceIncludes(/** @type {string} */ text, /** @type {string} */ base, /** @type {any} */ read, depth = 0) {
  let fence = "";
  return text.split("\n").map(line => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = ""; return line; }
    if (f) { fence = f[1]; return line; }
    const m = line.match(/^ {0,3}<!--\s*include:\s*(\S+?)\s*-->[ \t]*$/);
    if (!m) return line;
    if (depth > 3) return "";
    const got = read(m[1], base);
    return got ? spliceIncludes(got.text.trim(), got.base, read, depth + 1) : "";
  }).join("\n");
}

/** Rendered HTML to searchable text. @param {string} html */
function plainText(html) {
  return decodeEntities(html
    .replace(/<a class="anchor"[^>]*>#<\/a>/g, "")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {any} site @param {{ title: string, pages: any[] }[]} nav */
function llmsTxt(site, nav) {
  const out = [`# ${site.title}`, "", `> ${site.summary}`, ""];
  out.push(`Every page is Markdown at the URL below. Everything in one file: ${site.url}/llms-full.txt`, "");
  for (const s of nav) {
    out.push(`## ${s.title}`, "");
    for (const p of s.pages) out.push(`- [${p.title}](${site.url}${p.mdUrl})${p.summary ? ": " + p.summary : ""}`);
    out.push("");
  }
  return out.join("\n");
}

/** @param {any} site @param {any[]} pages */
function sitemap(site, pages) {
  const urls = pages.map(p => `  <url><loc>${escapeHtml(site.url + encodePath(p.url))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/**
 * Cloudflare Pages headers. Each .md is listed by name rather than with a `/*.md` pattern, so the
 * type is right whatever Pages' pattern rules allow; the rule count stays far under Pages' 100.
 * Only one rule sets Cache-Control for any path: Pages joins repeated headers with commas.
 * @param {any[]} pages
 */
function headers(pages) {
  const out = [
    "# Written by scripts/build-docs.",
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/search-index.json",
    "  Cache-Control: public, max-age=300",
    "",
    "/llms.txt",
    "  Content-Type: text/plain; charset=utf-8",
    "  Cache-Control: public, max-age=300",
    "",
    "/llms-full.txt",
    "  Content-Type: text/plain; charset=utf-8",
    "  Cache-Control: public, max-age=300",
    "",
  ];
  for (const p of pages) out.push(encodePath(p.mdUrl), "  Content-Type: text/markdown; charset=utf-8", "  Cache-Control: public, max-age=300", "");
  return out.join("\n");
}

/**
 * @param {object} o
 * @param {any} o.site
 * @param {any} o.page null for the 404 page
 * @param {{ title: string, pages: any[] }[]} o.nav
 * @param {any} o.prev
 * @param {any} o.next
 * @param {string} o.body
 * @param {{ level: number, text: string, id: string }[]} o.headings
 * @param {{ css: string, js: string }} o.assets
 */
function renderPage({ site, page, nav, prev, next, body, headings, assets }) {
  const e = escapeHtml;
  const title = page ? `${page.title} · ${site.title}` : `Not found · ${site.title}`;
  const desc = page?.summary || site.summary;
  const canonical = page ? site.url + encodePath(page.url) : "";
  const status = page ? String(page.data.status || "").toLowerCase() : "";
  const badge = status === "draft" || status === "planned"
    ? `<span class="badge badge-${status}">${status === "draft" ? "Draft" : "Planned"}</span>` : "";

  const side = nav.map(s => {
    const items = s.pages.map(p => {
      const cur = page && p.path === page.path;
      return `<li><a href="${e(encodePath(p.url))}"${cur ? ` aria-current="page"` : ""}>${e(p.title)}</a></li>`;
    }).join("");
    return `<div class="side-sec"><p class="lbl">${e(s.title)}</p><ul>${items}</ul></div>`;
  }).join("\n");

  const tocItems = headings.filter(h => h.level === 2 || h.level === 3);
  const toc = tocItems.length > 1
    ? `<aside class="toc" aria-label="On this page"><p class="lbl">On this page</p><ul>${tocItems.map(h =>
      `<li class="toc-${h.level}"><a href="#${e(encodeURIComponent(h.id))}">${e(h.text)}</a></li>`).join("")}</ul></aside>`
    : `<aside class="toc" aria-hidden="true"></aside>`;

  const hasH1 = /^<h1[ >]/.test(body);
  const article = page && !hasH1 ? `<h1>${e(page.title)}</h1>\n${body}` : body;

  let foot = "";
  if (page) {
    const owner = page.data.owner ? `<span>Owner <b>${e(String(page.data.owner))}</b></span>` : "";
    const aud = listOf(page.data.audience);
    const audience = aud.length ? `<span>For <b>${e(aud.join(", "))}</b></span>` : "";
    const st = status ? `<span>Status <b>${e(status)}</b></span>` : "";
    const pn = (/** @type {any} */ p, /** @type {string} */ dir) => p
      ? `<a class="pn pn-${dir}" href="${e(encodePath(p.url))}" rel="${dir}"><span class="lbl">${dir === "prev" ? "Previous" : "Next"}</span><span class="pn-t">${e(p.title)}</span></a>`
      : `<span class="pn pn-${dir} pn-none"></span>`;
    foot = `<footer class="doc-foot">
<div class="doc-links"><a href="${e(site.repo)}/blob/main/docs/${e(encodePath(page.path))}">Edit this page</a><a href="${e(encodePath(page.mdUrl))}" type="text/markdown">View as markdown</a></div>
<div class="doc-meta">${owner}${audience}${st}</div>
<nav class="pn-row" aria-label="Previous and next">${pn(prev, "prev")}${pn(next, "next")}</nav>
</footer>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
${page ? `<link rel="canonical" href="${e(canonical)}">\n<link rel="alternate" type="text/markdown" href="${e(encodePath(page.mdUrl))}">` : `<meta name="robots" content="noindex">`}
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0E0D0C">
<script>${THEME_BOOT}</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${e(FONTS)}">
<link rel="stylesheet" href="${assets.css}">
<script src="${assets.js}" defer></script>
<meta property="og:type" content="article">
<meta property="og:site_name" content="${e(site.title)}">
<meta property="og:title" content="${e(page ? page.title : "Not found")}">
<meta property="og:description" content="${e(desc)}">
${page ? `<meta property="og:url" content="${e(canonical)}">\n` : ""}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<div class="top-in">
<button class="icon-btn menu" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">${ICON_MENU}</button>
<a class="brand" href="/" aria-label="Vyre docs home">${MARK}${WORDMARK}<span class="brand-rule" aria-hidden="true"></span><span class="brand-docs">docs</span></a>
<div class="search" role="search">
<label class="sr-only" for="q">Search the docs</label>
${ICON_SEARCH}<input id="q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="q-results"><kbd class="kbd search-key" aria-hidden="true">/</kbd>
<div class="results" id="q-results" role="listbox" aria-label="Search results" hidden></div>
</div>
<a class="top-link" href="${e(site.repo)}">GitHub</a>
<button class="icon-btn theme" type="button" aria-label="Switch theme">${ICON_SUN}${ICON_MOON}</button>
</div>
</header>
<div class="layout">
<nav class="side" id="sidebar" aria-label="Docs">
${side}
</nav>
<div class="scrim" hidden></div>
<main id="main" class="main">
<article class="doc">
${page ? `<p class="doc-sec"><span class="lbl">${e(page.section)}</span>${badge}</p>\n` : ""}${article}
</article>
${foot}
</main>
${toc}
</div>
</body>
</html>
`;
}

