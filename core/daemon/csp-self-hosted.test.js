// A self-hosted Vyre does not call another company when a device pairs (S2: no third-party host in shipped code). The pairing pages, the app's CSP and the box's CSP name only this box.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("the public site's pages, stylesheet and headers load nothing from another company", () => {
  const files = siteFiles(path.join(root, "site"));
  assert.ok(files.length >= 10, "the site's files were found");
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(root, f);
    assert.doesNotMatch(text, FONT_HOSTS, `${rel} names an outside font or script host`);
    assert.doesNotMatch(text, /@import\s+(?:url\()?["']?https?:/i, `${rel} imports an outside stylesheet`);
    assert.doesNotMatch(text, /url\(\s*["']?https?:\/\/(?!vyre\.run)/i, `${rel} reads an outside file from CSS`);
    for (const tag of text.match(LOADERS) || []) {
      if (/\brel="(?:canonical|alternate|author|license|me)"/i.test(tag)) continue;
      assert.match(tag, /(?:href|src)="https?:\/\/vyre\.run[/"]/, `${rel} loads from another origin: ${tag.slice(0, 120)}`);
    }
  }
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
