// @ts-check
// check: everything scripts/docs-check holds docs/ to. It returns problems; it never prints or
// exits, so test/docs-check.test.js can run it on the real tree and on fixture trees alike.
//
// A problem is { file, line, kind, problem }, file relative to the repository root. Kinds:
//   links         a relative link to a file that is not there, an #anchor no heading makes, a
//                 published page linking into an unpublished folder, a docs.vyre.run path that
//                 no page serves
//   front-matter  missing, unreadable, a required key absent, a value outside the allowed set
//   nav           a published page the nav leaves out, a nav entry with no file, a redirect stub
//                 in the nav
//   redirect      a stub whose target is missing, unpublished, or itself a stub
//   characters    an em dash or a section sign, in a page or in a file it includes
//   hygiene       a real person's or business's name, a secret, an email address or IP address
//                 that is not an example (scripts/lib/hygiene.js)
//   reference     a generated page under docs/reference/ (or docs/index.json) that differs from
//                 what the code and the pages make
//   stale         inline code or a command line naming a Vyre thing the code no longer has
//   syntax        a `:::` container that is unknown, stray or never closed, a demo no widget
//                 draws, a `[!SNAG]` or `[!WHY]` with no title, a colors directive that is not
//                 dark or light
//
// `:::` lines and `<!-- colors: ... -->` lines are page syntax, not prose: nothing that reads prose
// sees them. Headings inside tabs make anchors like any other, and a `> [!SNAG] Title` makes one
// from its title, from the same pool as the headings (as the build does).
//
// Pages in the nav's "unpublished" folders are not checked at all: they are internal notes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "../hygiene.js";
import { DEMOS, directive, isDirective } from "./markdown.js";
import { slugger } from "./slug.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");

export const AUDIENCES = ["users", "builders", "operators", "agents"];
export const STATUSES = ["stable", "draft", "planned"];
export const OWNERS = ["tailnet", "capsule-pro", "capsule-sight", "connectors", "mobile", "polish-cli", "polish-surfaces", "e2e", "integrator", "docs", "planner", "cc-plugin", "glass-live", "pwa", "resilience"];
const REQUIRED = ["title", "summary", "audience", "owner", "status"];
const KEYS = [...REQUIRED, "generated"];
const SITE_HOSTS = ["docs.vyre.run"];
// Files the build writes beside the pages, which a page may link to.
const BUILT = ["/llms.txt", "/llms-full.txt", "/sitemap.xml", "/search-index.json", "/index.json", "/404.html"];
const EM_DASH = "\u2014", SECTION = "\u00a7";
const INCLUDE = /^\s*<!--\s*include:\s*(\S+)\s*-->\s*$/;

/** @typedef {{ file: string, line: number, kind: string, problem: string }} Problem */

/**
 * Front matter: the `key: value` lines between a leading --- and the next ---.
 * @param {string} text
 * @returns {{ data: Record<string, string>, lines: Record<string, number>, bad: { line: number, text: string }[], end: number } | null}
 */
export function frontMatter(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  /** @type {Record<string, string>} */ const data = {};
  /** @type {Record<string, number>} */ const at = {};
  const bad = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "---") return { data, lines: at, bad, end: i + 1 };
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) { bad.push({ line: i + 1, text: raw.trim() }); continue; }
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    data[m[1]] = v;
    at[m[1]] = i + 1;
  }
  return null; // never closed
}

/** Split a comma separated front-matter value. */
const csv = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

/**
 * Walk a markdown text line by line, outside fenced code, handing each line (with inline code
 * blanked out, so a link shown as code is not a link) to fn.
 * @param {string} text @param {(line: string, n: number, raw: string) => void} fn
 */
function prose(text, fn) {
  let fence = null;
  text.split("\n").forEach((raw, i) => {
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !raw.trim().slice(f[1].length).trim()) fence = null; return; }
    if (f) { fence = f[1]; return; }
    if (isDirective(raw)) return;
    fn(raw.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, m => " ".repeat(m.length)), i + 1, raw);
  });
}

/** The body of a page after its front matter, with the line offset of its first line. */
function body(text) {
  const fm = frontMatter(text);
  if (!fm) return { text, offset: 0 };
  return { text: text.split("\n").slice(fm.end).join("\n"), offset: fm.end };
}

/** Anchors a markdown text defines: heading slugs, GitHub-style, and explicit HTML ids. */
function anchorsOf(text, slug = slugger(), into = new Set()) {
  let prev = "";
  prose(body(text).text, (line, n, raw) => {
    const atx = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    const snag = raw.match(SNAG);
    if (atx) into.add(slug(atx[2]));
    else if (snag) into.add(slug(snag[1] || "If this happens"));
    else if (/^\s{0,3}(=+|-+)\s*$/.test(raw) && prev.trim() && !/^\s{0,3}([-*+]|\d+[.)])\s|^\s*\||^\s*>|^\s{0,3}#/.test(prev) && !/^\s*-+\s*$/.test(prev)) into.add(slug(prev.trim()));
    for (const m of line.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) into.add(m[1]);
    prev = raw;
  });
  return into;
}

const SNAG = /^\s*(?:>\s?)+\s*\[!SNAG\](?:[ \t]+(.*?))?\s*$/i;
const TITLED = /^\s*(?:>\s?)+\s*\[!(SNAG|WHY)\]\s*$/i;

/**
 * Page syntax problems in a markdown text: `:::` containers and the colors directive, and the
 * alerts that need a title. Lines inside fenced code are examples and are skipped.
 * @param {string} text @param {number} offset
 * @returns {{ line: number, problem: string }[]}
 */
export function syntaxOf(text, offset = 0) {
  const out = [];
  /** @type {{ kind: string, line: number, tabs: number }[]} */
  const open = [];
  let fence = null;
  text.split("\n").forEach((raw, i) => {
    const n = i + 1 + offset;
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !raw.trim().slice(f[1].length).trim()) fence = null; return; }
    if (f) { fence = f[1]; return; }
    const t = raw.match(TITLED);
    if (t) out.push({ line: n, problem: t[1].toUpperCase() === "SNAG" ? "[!SNAG] needs a title: what the reader sees, on the same line" : "[!WHY] needs a question on the same line" });
    const d = directive(raw);
    if (!d) return;
    const top = open[open.length - 1];
    if (d.kind === "tabs") open.push({ kind: "tabs", line: n, tabs: 0 });
    else if (d.kind === "demo") {
      open.push({ kind: "demo", line: n, tabs: 0 });
      if (!d.arg) out.push({ line: n, problem: `::: demo needs a widget name (${DEMOS.join(", ")})` });
      else if (!DEMOS.includes(d.arg.toLowerCase())) out.push({ line: n, problem: `::: demo ${d.arg}: no such widget (${DEMOS.join(", ")})` });
    } else if (d.kind === "tab") {
      if (!top || top.kind !== "tabs") out.push({ line: n, problem: "::: tab outside a ::: tabs group" });
      else top.tabs++;
      if (!d.arg) out.push({ line: n, problem: "::: tab needs a label" });
    } else if (d.kind === "close") {
      if (!top) out.push({ line: n, problem: "::: closes nothing" });
      else {
        open.pop();
        if (top.kind === "tabs" && !top.tabs) out.push({ line: top.line, problem: "::: tabs has no ::: tab in it" });
      }
    } else if (d.kind === "colors") {
      if (d.arg !== "dark" && d.arg !== "light") out.push({ line: n, problem: `colors directive must be dark or light, not ${d.arg || "empty"}` });
    } else out.push({ line: n, problem: `unknown container ::: ${d.arg} (tabs, tab, demo)` });
  });
  for (const o of open) out.push({ line: o.line, problem: `::: ${o.kind} is never closed with a ::: line` });
  return out;
}

/** Links in a markdown text: [{ target, line }]. */
function linksOf(text, offset) {
  const out = [];
  prose(text, (line, n) => {
    for (const m of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) out.push({ target: m[1].replace(/^<|>$/g, ""), line: n + offset });
    for (const m of line.matchAll(/<(?:a|img)\s[^>]*(?:href|src)=["']([^"']+)["']/gi)) out.push({ target: m[1], line: n + offset });
    const def = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/);
    if (def) out.push({ target: def[1].replace(/^<|>$/g, ""), line: n + offset });
  });
  return out;
}

/** All .md files under a folder, relative to it, sorted. */
function markdown(dir, rel = "") {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...markdown(dir, r));
    else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}

/**
 * Check a docs tree.
 * @param {{ root?: string, tmp?: string, reference?: false | (() => Record<string, string>) }} [opts]
 *   root: the repository (docs/ is under it). reference: a function returning the generated pages
 *   ({ "reference/cli.md": text }), or false to skip the staleness check. tmp: where the
 *   reference generator may make its throwaway home (tests pass their scratch folder).
 * @returns {Promise<Problem[]>}
 */
export async function check({ root = REPO, tmp, reference } = {}) {
  const docs = path.join(root, "docs");
  const rel = p => path.relative(root, p).split(path.sep).join("/");
  /** @type {Problem[]} */ const problems = [];
  const add = (file, line, kind, problem) => problems.push({ file, line, kind, problem });

  // The nav.
  const navFile = path.join(docs, "nav.json");
  let navText = "", nav = { sections: [], unpublished: [] };
  try { navText = fs.readFileSync(navFile, "utf8"); nav = JSON.parse(navText); }
  catch (e) { add("docs/nav.json", 1, "nav", `nav.json unreadable: ${/** @type {Error} */ (e).message}`); }
  const unpublished = (nav.unpublished || []).map(u => String(u).replace(/^\/+/, "").replace(/\/?$/, "/"));
  const isUnpublished = r => unpublished.some(u => r.startsWith(u));
  const navLine = page => { const i = navText.indexOf(`"${page}"`); return i < 0 ? 1 : navText.slice(0, i).split("\n").length; };
  /** @type {Map<string, number>} */ const inNav = new Map();
  for (const s of nav.sections || []) for (const p of s.pages || []) {
    if (inNav.has(p)) add("docs/nav.json", navLine(p), "nav", `${p} is listed twice`);
    inNav.set(p, navLine(p));
  }

  // Every page, and what each one is.
  const all = markdown(docs);
  const published = all.filter(r => !isUnpublished(r));
  /** @type {Map<string, string>} */ const text = new Map();
  /** @type {Map<string, ReturnType<typeof frontMatter>>} */ const fms = new Map();
  for (const r of published) { const t = fs.readFileSync(path.join(docs, r), "utf8"); text.set(r, t); fms.set(r, frontMatter(t)); }
  const isStub = r => Boolean(fms.get(r)?.data.redirect);

  for (const [p, line] of inNav) {
    if (isUnpublished(p)) add("docs/nav.json", line, "nav", `${p} is in an unpublished folder`);
    else if (!text.has(p)) add("docs/nav.json", line, "nav", `${p} is in the nav but there is no such file`);
    else if (isStub(p)) add("docs/nav.json", line, "nav", `${p} is a redirect stub; list its target instead`);
  }

  // Front matter, redirects and the nav, page by page.
  for (const r of published) {
    const file = `docs/${r}`, fm = fms.get(r);
    if (!fm) { add(file, 1, "front-matter", "no front matter (a --- block with title, summary, audience, owner, status)"); if (!inNav.has(r)) add(file, 1, "nav", "not in docs/nav.json"); continue; }
    for (const b of fm.bad) add(file, b.line, "front-matter", `front matter line not understood: ${b.text}`);
    const d = fm.data, at = k => fm.lines[k] || 1;
    if (d.redirect !== undefined) {
      for (const k of Object.keys(d)) if (k !== "title" && k !== "redirect") add(file, at(k), "redirect", `a redirect stub has only title and redirect, not ${k}`);
      if (!d.title) add(file, 1, "front-matter", "a redirect stub needs a title");
      const target = path.posix.normalize(d.redirect.replace(/^\/+/, "").replace(/#.*$/, ""));
      if (!d.redirect) add(file, at("redirect"), "redirect", "redirect is empty");
      else if (isUnpublished(target)) add(file, at("redirect"), "redirect", `redirects into an unpublished folder: ${d.redirect}`);
      else if (!text.has(target)) add(file, at("redirect"), "redirect", `redirects to ${d.redirect}, which does not exist`);
      else if (isStub(target)) add(file, at("redirect"), "redirect", `redirects to ${d.redirect}, which is itself a redirect; point at its target`);
      continue;
    }
    if (!inNav.has(r)) add(file, 1, "nav", "not in docs/nav.json (add it, or make it a redirect stub)");
    for (const k of REQUIRED) if (!d[k]) add(file, 1, "front-matter", `front matter has no ${k}`);
    for (const k of Object.keys(d)) if (!KEYS.includes(k)) add(file, at(k), "front-matter", `unknown front matter key ${k}`);
    if (d.audience) { const bad = csv(d.audience).filter(a => !AUDIENCES.includes(a)); if (bad.length || !csv(d.audience).length) add(file, at("audience"), "front-matter", `audience must be from ${AUDIENCES.join(", ")}; got ${d.audience}`); }
    if (d.status && !STATUSES.includes(d.status)) add(file, at("status"), "front-matter", `status must be one of ${STATUSES.join(", ")}; got ${d.status}`);
    if (d.owner && !OWNERS.includes(d.owner)) add(file, at("owner"), "front-matter", `owner ${d.owner} is not a known team (${OWNERS.join(", ")})`);
  }

  // Page syntax: containers, directives and titled alerts.
  for (const r of published) {
    if (isStub(r)) continue;
    const { text: b, offset } = body(/** @type {string} */ (text.get(r)));
    for (const p of syntaxOf(b, offset)) add(`docs/${r}`, p.line, "syntax", p.problem);
  }

  // Includes, characters and hygiene: every published page and every file it includes.
  /** @type {Map<string, string[]>} included files (repo-relative) per page */
  const includes = new Map();
  const scanned = new Set();
  const scan = (file, t) => {
    if (scanned.has(file)) return;
    scanned.add(file);
    t.split("\n").forEach((l, i) => {
      if (l.includes(EM_DASH)) add(file, i + 1, "characters", "em dash; use a colon, a comma or two sentences");
      if (l.includes(SECTION)) add(file, i + 1, "characters", "section sign; write Section 5.1");
    });
    for (const h of scanText(t)) add(file, h.line, "hygiene", h.problem);
  };
  for (const r of published) {
    const file = `docs/${r}`, t = /** @type {string} */ (text.get(r));
    scan(file, t);
    const inc = [];
    prose(t, (l, n, raw) => {
      const i = n - 1, m = raw.match(INCLUDE);
      if (!m) return;
      const abs = path.resolve(path.dirname(path.join(docs, r)), m[1]);
      const incRel = rel(abs);
      if (incRel.startsWith("..") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { add(file, i + 1, "links", `includes ${m[1]}, which does not exist`); return; }
      inc.push(incRel);
      scan(incRel, fs.readFileSync(abs, "utf8"));
    });
    includes.set(r, inc);
  }

  // Anchors, per page (with what it includes), computed on demand.
  /** @type {Map<string, Set<string>>} */ const anchorCache = new Map();
  const anchors = r => {
    if (anchorCache.has(r)) return /** @type {Set<string>} */ (anchorCache.get(r));
    const slug = slugger(), set = new Set();
    const t = text.get(r) ?? (fs.existsSync(path.join(docs, r)) ? fs.readFileSync(path.join(docs, r), "utf8") : "");
    const parts = t.split("\n");
    let chunk = [];
    const flush = () => { anchorsOf(chunk.join("\n"), slug, set); chunk = []; };
    let fence = null; // an include line inside fenced code is an example, not an include
    for (const l of parts) {
      const f = l.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence && f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().slice(f[1].length).trim()) fence = null;
      else if (!fence && f) fence = f[1];
      const m = !fence && l.match(INCLUDE);
      if (!m) { chunk.push(l); continue; }
      flush();
      const abs = path.resolve(path.dirname(path.join(docs, r)), m[1]);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) anchorsOf(fs.readFileSync(abs, "utf8"), slug, set);
    }
    flush();
    anchorCache.set(r, set);
    return set;
  };
  // A stub's anchors are its target's: the build turns it into a redirect.
  const resolved = r => (isStub(r) ? path.posix.normalize(String(fms.get(r)?.data.redirect).replace(/^\/+/, "").replace(/#.*$/, "")) : r);

  // What docs.vyre.run serves: each published page at its path, with or without .html or a slash.
  const served = new Map();
  for (const r of published) {
    const base = "/" + r.replace(/\.md$/, "");
    const forms = [base, `${base}/`, `${base}.html`, `/${r}`];
    if (/(^|\/)index$/.test(base)) { const dir = base.replace(/index$/, ""); forms.push(dir, dir.replace(/\/$/, "") || "/"); }
    for (const f of forms) { served.set(f, r); served.set(f.toLowerCase(), r); }
  }
  const servedAsset = p => { const f = path.join(docs, decodeURIComponent(p)); return BUILT.includes(p) || (fs.existsSync(f) && fs.statSync(f).isFile() && !isUnpublished(p.replace(/^\//, ""))); };

  // Links, in each published page's own text.
  for (const r of published) {
    if (isStub(r)) continue;
    const file = `docs/${r}`;
    const { text: b, offset } = body(/** @type {string} */ (text.get(r)));
    for (const { target, line } of linksOf(b, offset)) {
      const bad = why => add(file, line, "links", `${target}: ${why}`);
      let t = target.trim();
      if (!t) { bad("empty link"); continue; }
      let siteUrl = null;
      const abs = t.match(/^https?:\/\/([^/?#]+)(.*)$/i);
      if (abs) { if (!SITE_HOSTS.includes(abs[1].toLowerCase())) continue; siteUrl = abs[2] || "/"; }
      else if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // mailto:, tel: and the like
      else if (t.startsWith("//")) continue;
      else if (t.startsWith("/")) siteUrl = t;
      if (siteUrl !== null) {
        const [p0, anchor] = siteUrl.replace(/\?[^#]*/, "").split("#");
        const p = p0 || "/";
        const page = served.get(p) || served.get(p.toLowerCase());
        if (!page) { if (!servedAsset(p)) bad("no page on docs.vyre.run has this path"); continue; }
        if (anchor && !anchors(resolved(page)).has(decodeURIComponent(anchor))) bad(`no heading in docs/${resolved(page)} makes the anchor #${anchor}`);
        continue;
      }
      const [p0, anchor] = t.replace(/\?[^#]*/, "").split("#");
      if (!p0) { if (anchor && !anchors(r).has(decodeURIComponent(anchor))) bad(`no heading on this page makes the anchor #${anchor}`); continue; }
      const absPath = path.resolve(path.dirname(path.join(docs, r)), decodeURIComponent(p0));
      const repoRel = rel(absPath);
      if (repoRel.startsWith("..")) { bad("points outside the repository"); continue; }
      const docsRel = path.relative(docs, absPath).split(path.sep).join("/");
      const inDocs = !docsRel.startsWith("..");
      const exists = fs.existsSync(absPath), isDir = exists && fs.statSync(absPath).isDirectory();
      if (inDocs && isUnpublished(isDir ? `${docsRel}/` : docsRel)) { bad("points into an unpublished folder"); continue; }
      if (!exists) { bad("no such file"); continue; }
      if (anchor && inDocs && docsRel.endsWith(".md")) {
        const target = resolved(docsRel);
        if (!anchors(target).has(decodeURIComponent(anchor))) bad(`no heading in docs/${target} makes the anchor #${anchor}`);
      }
    }
  }

  // Stale mentions: a command, tool, config key or VYRE_ variable a page names that the code no
  // longer has (scripts/lib/docs/terms.js).
  for (const p of (await import("./terms.js")).staleMentions(root, published.filter(r => !isStub(r)).map(r => ({ rel: r, source: /** @type {string} */ (text.get(r)) })))) problems.push(p);

  // Generated reference pages.
  if (reference !== false) {
    /** @type {Record<string, string>} */ let pages = {};
    try { pages = reference ? reference() : (await import("./reference.js")).generateAll({ root, tmp }); }
    catch (e) { add("scripts/gen-docs-reference", 1, "reference", `could not build the reference pages: ${/** @type {Error} */ (e).message}`); }
    for (const [r, want] of Object.entries(pages)) {
      let now = null;
      try { now = fs.readFileSync(path.join(docs, r), "utf8"); } catch {}
      if (now === null) add(`docs/${r}`, 1, "reference", "generated page is missing; run npm run docs:ref");
      else if (now !== want) {
        const a = now.split("\n"), b = want.split("\n");
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        add(`docs/${r}`, i + 1, "reference", "generated page is stale; run npm run docs:ref (edit the code, not the page)");
      }
    }
  }

  problems.push(...(await import("./shots.js")).checkShots({ root })); // screenshots older than the code they show (kind `shots`)

  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.problem < b.problem ? -1 : 1)));
}

/** @param {Problem[]} problems */
export const format = problems => problems.map(p => `${p.file}:${p.line}: ${p.problem}`);

/** Counts by kind, for a summary line. @param {Problem[]} problems */
export function counts(problems) {
  const out = {};
  for (const p of problems) out[p.kind] = (out[p.kind] || 0) + 1;
  return out;
}
