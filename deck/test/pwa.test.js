// @ts-check
// The installed phone app's static promises: every file the service worker keeps at install
// exists, the manifest's icons and the iOS launch screens are really there, and the service
// worker still never caches a tool call beyond its two offline reads.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");
const exists = (/** @type {string} */ p) => fs.existsSync(path.join(DECK, p === "/" ? "index.html" : p.slice(1)));

test("pwa: every path the service worker keeps at install is a file in deck/", () => {
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(read("sw.js"));
  assert.ok(m, "SHELL list in sw.js");
  const paths = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  assert.ok(paths.length > 20);
  for (const p of paths) assert.ok(exists(p), `${p} is kept at install but is not in deck/`);
});

test("pwa: every view module a phone tab imports is kept at install", () => {
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(read("sw.js"));
  const kept = new Set([...(m?.[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]));
  const seen = new Set();
  const walk = (/** @type {string} */ p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const [, spec] of read(p.slice(1)).matchAll(/^import (?:[^"]*from )?"([^"]+)"/gm)) walk(path.posix.resolve(path.posix.dirname(p), spec));
  };
  for (const v of ["now", "projects", "chat", "find", "agents", "needs"]) walk(`/views/${v}.js`);
  walk("/js/app.js");
  walk("/chat/index.js");
  for (const p of seen) assert.ok(kept.has(p), `${p} is imported by the shell or a phone tab but not kept at install`);
});

test("pwa: the manifest installs standalone with any and maskable icons that exist", () => {
  const man = JSON.parse(read("manifest.webmanifest"));
  assert.equal(man.display, "standalone");
  assert.equal(man.start_url, "/now");
  assert.equal(man.background_color, "#0E0D0C", "Graphite, from TOKENS.md");
  assert.equal(man.theme_color, "#0E0D0C");
  const purposes = new Set(man.icons.map((/** @type {any} */ i) => i.purpose));
  assert.ok(purposes.has("any") && purposes.has("maskable"));
  for (const i of man.icons) assert.ok(exists(i.src), i.src);
  for (const s of man.shortcuts || []) assert.ok(s.url.startsWith("/"));
});

test("pwa: index.html has the iOS home-screen tags, and each launch screen it names exists", () => {
  const html = read("index.html");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  const splash = [...html.matchAll(/apple-touch-startup-image" href="([^"]+)"/g)].map(x => x[1]);
  assert.ok(splash.length >= 10);
  for (const s of splash) assert.ok(exists(s), s);
});

test("pwa: the service worker caches no tool call but its two offline reads", () => {
  const sw = read("sw.js");
  assert.match(sw, /OFFLINE_TOOLS = new Set\(\["threads\.get", "projects\.list"\]\)/);
  assert.match(sw, /url\.pathname\.startsWith\("\/v1\/"\)/, "GETs under /v1/ are never cached");
});
