// @ts-check
// The docs on vyre.run (scripts/build-docs --mount-site, scripts/site/docs.mjs): every page is at /docs/ as HTML and as its own Markdown, the
// root files (ARCHITECTURE.md, DEVELOPMENT-RULES.md, roadmap/) join them, every link on a page resolves inside the build or to vyre.run's own
// pages, and the assembler and the sitemap and llms files carry it.

import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { build } from "../scripts/lib/docs/build.js";
import { mountOptions, extras, llmsDocs, docsPaths } from "../scripts/site/docs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// vyre.run's own pages, which the docs link to from the header
const SITE_PAGES = new Set(["/", "/architecture/", "/direction/", "/start/", "/favicon.svg"]);

// Each test builds its own copy: tempHome removes its folder when the test ends.
function out(/** @type {any} */ t) {
  const dir = path.join(tempHome(t), "docs-out");
  const r = build({ root: REPO, out: dir, ...mountOptions(REPO) });
  return { out: dir, files: r.files };
}
const read = (/** @type {{ out: string }} */ b, /** @type {string} */ f) => fs.readFileSync(path.join(b.out, f), "utf8");

test("site docs: the root files and every roadmap plan are pages, each with its Markdown", (t) => {
  const b = out(t);
  const want = extras(REPO).map(x => x.path);
  assert.ok(want.includes("project/ARCHITECTURE.md") && want.includes("project/DEVELOPMENT-RULES.md") && want.includes("roadmap/README.md"));
  assert.equal(want.filter(p => p.startsWith("roadmap/")).length, fs.readdirSync(path.join(REPO, "roadmap")).filter(n => n.endsWith(".md")).length);
  for (const p of [...want, "for-agents/MAP-YOUR-BUSINESS.md", "architecture/overview.md", "index.md"]) {
    assert.ok(b.files.includes(p), `${p} (Markdown)`);
    assert.ok(b.files.includes(p.replace(/\.md$/, ".html")), `${p} (HTML)`);
  }
  assert.ok(!b.files.includes("robots.txt") && !b.files.includes("404.html"), "the site has those");
});

test("site docs: every link and asset on every page resolves inside /docs or to a vyre.run page", (t) => {
  const b = out(t);
  const have = new Set(b.files.map(f => "/docs/" + f));
  const bad = [];
  for (const f of b.files.filter(f => f.endsWith(".html"))) {
    const html = read(b, f);
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)[^"]*"/g)) {
      const u = decodeURIComponent(m[1]);
      if (SITE_PAGES.has(u)) continue;
      const ok = u.startsWith("/docs/") && (have.has(u) || have.has(u + ".html") || have.has(u + "index.html") || u === "/docs/");
      if (!ok) bad.push(`${f}: ${u}`);
    }
  }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} links do not resolve`);
});

test("site docs: links in the published Markdown work from where the file is served", (t) => {
  const b = out(t);
  const arch = read(b, "project/ARCHITECTURE.md");
  assert.match(arch, /\]\(https:\/\/vyre\.run\/docs\/architecture\/overview\.md\)/, "a docs page from the root file");
  assert.match(arch, /\]\(https:\/\/github\.com\/vyre-ai\/vyre\/blob\/main\/CHANGELOG\.md\)/, "a file the site does not publish goes to the repo");
  assert.ok(!/\]\(docs\//.test(arch), "no link is left relative to the repo root");
  const map = read(b, "for-agents/MAP-YOUR-BUSINESS.md");
  assert.match(map, /\]\(https:\/\/vyre\.run\/docs\/project\/ARCHITECTURE\.md/, "a docs page that links to a root file");
  assert.match(map, /\]\(\.\.\/architecture\/features\/agents\.md\)/, "docs to docs stays relative, it works as served");
  const html = read(b, "for-agents/MAP-YOUR-BUSINESS.html");
  assert.match(html, /href="\/docs\/project\/ARCHITECTURE(#[^"]*)?"/);
  assert.match(html, /<html lang="en" data-base="\/docs">/);
  assert.match(html, /<nav class="top-nav" aria-label="vyre\.run">/);
});

test("site docs: sitemap, llms.txt and search carry the /docs prefix", (t) => {
  const b = out(t);
  assert.match(read(b, "sitemap.xml"), /<loc>https:\/\/vyre\.run\/docs\/project\/ARCHITECTURE<\/loc>/);
  const llms = read(b, "llms.txt");
  assert.match(llms, /\(https:\/\/vyre\.run\/docs\/project\/ARCHITECTURE\.md\)/);
  assert.ok(!/\(https:\/\/vyre\.run\/(?!docs\/)/.test(llms), "every link is under /docs");
  const idx = JSON.parse(read(b, "search-index.json"));
  assert.ok(idx.pages.every((/** @type {any} */ p) => p.u === "/docs/" || p.u.startsWith("/docs/")));
  assert.match(read(b, "assets/" + b.files.find(f => /^assets\/docs\..*\.js$/.test(f))?.slice(7)), /data-base/);
  assert.ok(!/(^|\n)\/\*\n/.test(read(b, "_headers")), "no rule for the whole site");
  assert.match(read(b, "_headers"), /^\/docs\/assets\/\*$/m);
});

test("site docs: the assembler builds it, and the site's sitemap, llms.txt and llms-full.txt point at it", async () => {
  const asm = fs.readFileSync(path.join(REPO, "scripts/assemble-site.sh"), "utf8");
  assert.match(asm, /node scripts\/build-docs --mount-site --out "\$out\/docs"/);
  assert.match(asm, /docs\/project\/ARCHITECTURE\.md/, "the served copy is checked");
  const sm = fs.readFileSync(path.join(REPO, "site/sitemap.xml"), "utf8");
  for (const p of await docsPaths(REPO)) assert.ok(sm.includes(`<loc>https://vyre.run${p}</loc>`), p);
  for (const f of ["site/llms.txt", "site/llms-full.txt"]) {
    const txt = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.ok(txt.includes(llmsDocs("https://vyre.run")), f);
  }
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/site-deploy.yml"), "utf8");
  assert.match(yml, /scripts\/assemble-site\.sh/, "the deploy goes through the assembler");
});

test("docs: code, prose addresses and mailto links carry Cloudflare's email_off markers, and check-email-off finds an unmarked address", async () => {
  const { renderMarkdown } = await import("../scripts/lib/docs/markdown.js");
  const { exposed } = await import("../scripts/check-email-off.mjs");
  const r = /** @type {any} */ (renderMarkdown("Run `vyre box add alex@192.0.2.10`, or write privacy@vyre.run, or <hi@vyre.run>.\n\n```sh\nvyre box add alex@192.0.2.10\n```\n"));
  const html = typeof r === "string" ? r : r.html;
  assert.match(html, /<!--email_off--><code>vyre box add alex@192\.0\.2\.10<\/code><!--\/email_off-->/);
  assert.match(html, /<!--email_off--><pre>/);
  assert.deepEqual(exposed(html), [], "nothing is left for the edge to rewrite");
  assert.deepEqual(exposed("<p>mail a@b.example</p>"), ["a@b.example"], "an unmarked address is found");
});
