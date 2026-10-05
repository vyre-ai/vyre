#!/usr/bin/env node
// @ts-check
// shell-hashes: writes DIR/shell.json, the sha256 of every code file (js, css, html) the daemon serves for the Deck plus deck/sw.js's SHELL list
// ({ v: 1, files: [[path, hex], ...] }, sorted). The release runs this into dist/ BEFORE
// scripts/sign-manifest.mjs, so SHA256SUMS lists shell.json and the one release signature covers
// it. The service worker checks a new shell against it (deck/sw.js verifyShell, reviewer N-H1).
// sw.js itself is left out: it is stamped with the build when served.
//
//   node scripts/shell-hashes.mjs DIR [VERSION]   (VERSION defaults to package.json's; the worker
//   refuses a release older than the highest it has accepted)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that are not the Deck's served code: tests and fixtures. The onboarding and sign-in pages ARE listed (the worker checks them too). */
const SKIP_DIR = new Set(["test", "fixtures", "node_modules"]);
const CODE = /\.(m?js|css|html)$/;
// Served from the repo root, not deck/ (core/daemon/index.js): the resilience files, the avatar rule, and the relay client's browser closure.
const ROOT_FILES = ["core/resilience/backoff.js", "core/resilience/sse.js", "core/resilience/stream.js", "core/resilience/outbox.js", "core/resilience/web.js",
  "lib/avatar-seed/index.js", ...["client", "channel", "bytes", "response", "sse", "webcrypto", "noise"].map((n) => `relay/client/${n}.js`)];

/** @param {string} dir @param {string} base @returns {string[]} paths relative to base */
function walk(dir, base) {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) out.push(...walk(path.join(dir, e.name), rel)); }
    else if (CODE.test(e.name) && !/\.test\.m?js$/.test(e.name) && rel !== "sw.js") out.push(rel);
  }
  return out;
}

/** A folder's index.html is also served at the folder's own address ("/onboard/passkey", with or without the slash), and "/" is "/index.html". @param {string} p @returns {string[]} */
const twin = (p) => (p === "/" ? ["/index.html"] : p.endsWith("/index.html") && p !== "/index.html" ? [p.slice(0, -"/index.html".length), p.slice(0, -"index.html".length)] : []);

/** The real files served as code (URL paths), "/" for index.html included, no twins. @param {string} [repo] */
function realCode(repo = REPO) {
  return [...new Set([...walk(path.join(repo, "deck"), "").map((r) => "/" + r), ...(fs.existsSync(path.join(repo, "web")) ? walk(path.join(repo, "web"), "").map((r) => "/" + r) : []), "/", ...ROOT_FILES.map((f) => "/" + f)])].sort();
}

/** Every code path the daemon serves for the Deck, addresses that serve the same file included: what the worker holds a signed shell to. @param {string} [repo] */
export function codePaths(repo = REPO) {
  const real = realCode(repo);
  return [...new Set([...real, ...real.flatMap(twin)])].sort();
}

/** The shell's precache paths, as sw.js lists them (sw.js itself is stamped per build, so it is left out). @param {string} [repo] */
export function shellPaths(repo = REPO) {
  const src = fs.readFileSync(path.join(repo, "deck", "sw.js"), "utf8");
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error("could not find sw.js's SHELL list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((p) => p !== "/sw.js");
}

/** web/ (the pre-app pages, ahead of the Deck at the same address) first, then the repo-root files, then deck/. */
const fileOf = (/** @type {string} */ repo, /** @type {string} */ p) => {
  const web = path.join(repo, "web", p.slice(1));
  if (p !== "/" && fs.existsSync(web) && fs.statSync(web).isFile()) return web;
  return ROOT_FILES.includes(p.slice(1)) ? path.join(repo, p.slice(1)) : path.join(repo, "deck", p === "/" ? "index.html" : p.slice(1));
};

/**
 * Every served code file (js, mjs, css, html) plus every precached shell file (images and fonts), with its sha256.
 * @param {string} [repo] @param {string} [version] @returns {{ v: 1, version: string, files: [string, string][] }}
 */
export function shellHashes(repo = REPO, version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version) {
  const real = [...new Set([...realCode(repo), ...shellPaths(repo)])];
  /** @type {Map<string, string>} */ const hashes = new Map();
  for (const p of real) {
    const h = crypto.createHash("sha256").update(fs.readFileSync(fileOf(repo, p))).digest("hex");
    hashes.set(p, h);
    for (const t of twin(p)) hashes.set(t, h);
  }
  /** @type {[string, string][]} */
  const files = [...hashes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { v: 1, version, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: shell-hashes.mjs DIR"); process.exit(2); }
  try {
    // --modules FILE --appbuild FILE: the release's signed module list and app record ride inside shell.json as exact text (lib/release-shell.js), so an old updater that knows only shell.json
    // still delivers them. The text must be the bytes of the files SHA256SUMS will list.
    const a = process.argv.slice(3);
    const opt = (/** @type {string} */ n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
    const ver = a[0] && !a[0].startsWith("--") ? a[0] : undefined;
    const s = /** @type {any} */ (shellHashes(REPO, ver));
    if (opt("--modules")) s.modulesJson = fs.readFileSync(/** @type {string} */ (opt("--modules")), "utf8");
    if (opt("--appbuild")) s.appbuildJson = fs.readFileSync(/** @type {string} */ (opt("--appbuild")), "utf8");
    fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify(s));
    console.log(`shell.json lists ${s.files.length} files`);
  } catch (e) { console.error(`shell-hashes: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
