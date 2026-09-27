// @ts-check
// Reading the docs tree: docs/nav.json, each page's front matter, the redirect stubs, and the one
// URL scheme everything else (the build, docs-check, tests) shares.
//
//   docs/index.md                 /                    written as index.html
//   docs/using/capsule.md         /using/capsule       written as using/capsule.html
//   docs/architecture/index.md    /architecture/       written as architecture/index.html
//
// Cloudflare Pages serves `using/capsule.html` at `/using/capsule`. The page's source, front
// matter kept, is also published beside it at `/using/capsule.md`.
//
// Only pages listed in nav.json are published. A page whose front matter has `redirect:` is a stub
// for a page that moved; it is published as a 301 and nothing else. `nav.unpublished` folders
// (work/, proposals/, design/boards/) never are, even when a stub sits in them.

import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./frontmatter.js";

/** @typedef {{ title?: string, url?: string, repo?: string, summary?: string }} Site */
/**
 * @typedef {object} Page
 * @property {string} path     docs-relative, e.g. "using/capsule.md"
 * @property {string} url      pretty URL, e.g. "/using/capsule"
 * @property {string} mdUrl    e.g. "/using/capsule.md"
 * @property {string} htmlFile output file, e.g. "using/capsule.html"
 * @property {string} file     absolute source path
 * @property {string} source   the file as written
 * @property {Record<string, string | string[]>} data front matter
 * @property {string} body     the file without its front matter
 * @property {string} section  nav section title
 * @property {string} title    front matter title, else the first heading, else the file name
 * @property {string} summary
 */
/** @typedef {{ from: string, to: string, file: string }} Redirect */
/**
 * @typedef {Page[] & { site: Site, sections: { title: string, pages: Page[] }[], redirects: Redirect[],
 *   missing: { path: string, section: string }[], unpublished: string[], docsDir: string }} Docs
 */

const DEFAULT_UNPUBLISHED = ["work/", "proposals/", "design/boards/"];

/** @param {string} p docs-relative .md path */
export function pageUrl(p) {
  const noExt = p.replace(/\.md$/, "");
  if (noExt === "index") return "/";
  if (noExt.endsWith("/index")) return "/" + noExt.slice(0, -"index".length);
  return "/" + noExt;
}

/** @param {string} p */
export function mdUrl(p) {
  return "/" + p;
}

/** @param {string} p */
export function htmlFile(p) {
  return p.replace(/\.md$/, ".html");
}

/** @param {string} p @param {string[]} [unpublished] */
export function isUnpublished(p, unpublished = DEFAULT_UNPUBLISHED) {
  return unpublished.some(u => p === u.replace(/\/$/, "") || p.startsWith(u.endsWith("/") ? u : u + "/"));
}

/**
 * What a link as written points at.
 *   external  a URL with a scheme, or protocol-relative
 *   anchor    `#section` on the same page
 *   absolute  a site path like `/using/capsule`
 *   doc       a file under docs/ (`path` is docs-relative; may not exist, may not be .md)
 *   repo      a file elsewhere in the repo (`path` is repo-relative)
 * @param {string} href
 * @param {string} base docs-relative folder of the file the link is in ("" for docs/, ".." for the repo root)
 * @returns {{ kind: "external" | "anchor" | "absolute" | "doc" | "repo", path: string, hash: string }}
 */
export function resolveDocLink(href, base) {
  const h = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return { kind: "external", path: h, hash: "" };
  if (h.startsWith("#")) return { kind: "anchor", path: "", hash: h.slice(1) };
  const hashAt = h.indexOf("#");
  const rawPath = (hashAt < 0 ? h : h.slice(0, hashAt)).replace(/\?.*$/, "");
  const hash = hashAt < 0 ? "" : h.slice(hashAt + 1);
  let decoded = rawPath;
  try { decoded = decodeURI(rawPath); } catch {}
  if (h.startsWith("/")) return { kind: "absolute", path: decoded, hash };
  const repoPath = path.posix.normalize(path.posix.join("docs", base || "", decoded));
  if (repoPath.startsWith("docs/")) return { kind: "doc", path: repoPath.slice(5) + (decoded.endsWith("/") && !repoPath.endsWith("/") ? "/" : ""), hash };
  if (repoPath === "docs") return { kind: "doc", path: "", hash };
  return { kind: "repo", path: repoPath, hash };
}

/** The first ATX heading's text, for pages without a front matter title. @param {string} body */
export function firstHeading(body) {
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m) return m[1].replace(/[`*_]/g, "").trim();
  }
  return "";
}

/** @param {string | string[] | undefined} v */
const str = v => (Array.isArray(v) ? v.join(", ") : v || "");

/**
 * Read docs/nav.json and every page it lists, plus the redirect stubs.
 * @param {string} root the repo root (the folder with docs/ in it)
 * @returns {Docs}
 */
export function loadDocs(root) {
  const docsDir = path.join(root, "docs");
  const nav = JSON.parse(fs.readFileSync(path.join(docsDir, "nav.json"), "utf8"));
  const unpublished = Array.isArray(nav.unpublished) ? nav.unpublished : DEFAULT_UNPUBLISHED;
  /** @type {Page[]} */
  const pages = [];
  const sections = [];
  const missing = [];
  const seen = new Set();
  for (const section of nav.sections || []) {
    const list = [];
    for (const p of section.pages || []) {
      if (seen.has(p) || isUnpublished(p, unpublished)) continue;
      const file = path.join(docsDir, p);
      let source;
      try { source = fs.readFileSync(file, "utf8"); } catch { missing.push({ path: p, section: section.title }); continue; }
      const { data, body } = parseFrontMatter(source);
      if (data.redirect) continue;
      seen.add(p);
      const page = {
        path: p, url: pageUrl(p), mdUrl: mdUrl(p), htmlFile: htmlFile(p), file,
        source: source.replace(/\r\n?/g, "\n"), data, body, section: section.title,
        title: str(data.title) || firstHeading(body) || path.posix.basename(p, ".md"),
        summary: str(data.summary),
      };
      pages.push(page);
      list.push(page);
    }
    sections.push({ title: section.title, pages: list });
  }

  /** @type {Redirect[]} */
  const redirects = [];
  for (const rel of walk(docsDir)) {
    if (isUnpublished(rel, unpublished) || seen.has(rel)) continue;
    const file = path.join(docsDir, rel);
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith("---")) continue;
    const { data } = parseFrontMatter(text);
    const to = str(data.redirect);
    if (to) redirects.push({ from: rel, to: path.posix.normalize(to.replace(/^\//, "")), file });
  }

  return Object.assign(pages, { site: nav.site || {}, sections, redirects, missing, unpublished, docsDir });
}

/** Every .md under dir, docs-relative, sorted. @param {string} dir */
function walk(dir, rel = "") {
  /** @type {string[]} */
  const out = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}
