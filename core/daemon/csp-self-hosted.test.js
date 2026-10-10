// A self-hosted Vyre does not call another company when a device pairs (S2: no third-party host in shipped code). The pairing pages, the app's CSP and the box's CSP name only this box.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CSP } from "./app.js";

const root = new URL("../../", import.meta.url).pathname;
const hosts = (/** @type {string} */ s) => [...s.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
const htmlIn = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? htmlIn(path.join(dir, e.name)) : e.name.endsWith(".html") ? [path.join(dir, e.name)] : []);

test("the onboarding pages load nothing from outside this box", () => {
  for (const f of htmlIn(path.join(root, "web", "onboard"))) assert.deepEqual(hosts(fs.readFileSync(f, "utf8")), [], `${path.relative(root, f)} names an outside host`);
});

test("both content security policies name no outside host, and the fonts they need are the box's own", () => {
  assert.deepEqual(hosts(CSP), []);
  const src = fs.readFileSync(path.join(root, "core", "daemon", "index.js"), "utf8");
  const policies = [...src.matchAll(/"content-security-policy": `([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ""));
  assert.ok(policies.length >= 1, "the box's policy was found");
  for (const p of policies) assert.deepEqual(hosts(p), [], p);
  assert.ok(fs.existsSync(path.join(root, "web", "fonts", "instrument-sans-latin.woff2")), "the sans face is served from web/fonts");
  assert.ok(fs.existsSync(path.join(root, "web", "fonts", "jetbrains-mono-latin.woff2")), "the mono face is served from web/fonts");
});

// The public site (site/, what vyre.run serves) is the first page someone sees, so it holds to the same rule.
const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i;
const LOADERS = /<(?:link|script|img|iframe|source|video|audio)\b[^>]*\b(?:href|src)="https?:\/\/[^"]*"[^>]*>/gi;
const siteFiles = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? siteFiles(path.join(dir, e.name)) : /\.(html|css|js)$/.test(e.name) || e.name === "_headers" ? [path.join(dir, e.name)] : []);

/** What a shipped file loads from outside: a font or script host, an imported or url() stylesheet, a tag that fetches from another origin. */
const outsideLoads = (/** @type {string} */ text, /** @type {RegExp} */ ownOrigin) => {
  const found = [];
  if (FONT_HOSTS.test(text)) found.push("names an outside font or script host");
  if (/@import\s+(?:url\()?["']?https?:/i.test(text)) found.push("imports an outside stylesheet");
  if (/url\(\s*["']?https?:\/\/(?!vyre\.run)/i.test(text)) found.push("reads an outside file from CSS");
  for (const tag of text.match(LOADERS) || []) {
    if (/\brel="(?:canonical|alternate|author|license|me)"/i.test(tag)) continue;
    if (!ownOrigin.test(tag)) found.push(`loads from another origin: ${tag.slice(0, 120)}`);
  }
  return found;
};

test("the public site's pages, stylesheet and headers load nothing from another company", () => {
  const files = siteFiles(path.join(root, "site"));
  assert.ok(files.length >= 10, "the site's files were found");
  for (const f of files) assert.deepEqual(outsideLoads(fs.readFileSync(f, "utf8"), /(?:href|src)="https?:\/\/vyre\.run[/"]/), [], path.relative(root, f));
});

test("the built docs (docs.vyre.run) load nothing from another company, and carry their own fonts", async () => {
  const { build } = await import("../../scripts/lib/docs/build.js");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-docs-fonts-"));
  try {
    build({ root, out, log: () => {} });
    const files = siteFiles(out);
    assert.ok(files.some((f) => f.endsWith("index.html")) && files.some((f) => f.endsWith("404.html")), "the docs pages were built");
    for (const f of files) assert.deepEqual(outsideLoads(fs.readFileSync(f, "utf8"), /(?:href|src)="https?:\/\/docs\.vyre\.run[/"]/), [], path.relative(out, f));
    const css = fs.readdirSync(path.join(out, "assets")).filter((n) => /^docs\..*\.css$/.test(n)).map((n) => fs.readFileSync(path.join(out, "assets", n), "utf8")).join("");
    for (const face of ["instrument-sans-latin", "jetbrains-mono-latin"]) {
      const m = css.match(new RegExp(`url\\((/assets/fonts/${face}\\.[0-9a-f]+\\.woff2)\\)`));
      assert.ok(m, `the docs stylesheet declares ${face}`);
      assert.ok(fs.readFileSync(path.join(out, m[1])).equals(fs.readFileSync(path.join(root, "web", "fonts", `${face}.woff2`))), `${face} is web/fonts/${face}.woff2`);
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("the public site serves its own fonts, the same files as the Deck's", () => {
  const css = fs.readFileSync(path.join(root, "site", "v2.css"), "utf8");
  for (const f of ["instrument-sans-latin.woff2", "jetbrains-mono-latin.woff2"]) {
    assert.ok(css.includes(`url(/fonts/${f})`), `v2.css declares ${f}`);
    const own = fs.readFileSync(path.join(root, "site", "fonts", f));
    assert.ok(own.equals(fs.readFileSync(path.join(root, "web", "fonts", f))), `site/fonts/${f} is web/fonts/${f}`);
  }
  const gen = fs.readFileSync(path.join(root, "scripts", "gen-site.mjs"), "utf8");
  assert.doesNotMatch(gen, /fonts\.googleapis|fonts\.gstatic/, "the page generator names no outside font host");
});
