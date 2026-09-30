#!/usr/bin/env node
// @ts-check
// shell-hashes: writes DIR/shell.json, the sha256 of every file in deck/sw.js's SHELL list
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
// Served from the repo root, not deck/ (core/daemon/index.js): the resilience files and the avatar rule.
const FROM_ROOT = /^\/(core\/resilience\/(backoff|sse|stream|outbox|web)\.js|lib\/avatar-seed\/index\.js)$/;

/** The shell's paths, as sw.js lists them. @param {string} [repo] */
export function shellPaths(repo = REPO) {
  const src = fs.readFileSync(path.join(repo, "deck", "sw.js"), "utf8");
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error("could not find sw.js's SHELL list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((p) => p !== "/sw.js");
}

/** @param {string} [repo] @param {string} [version] @returns {{ v: 1, version: string, files: [string, string][] }} */
export function shellHashes(repo = REPO, version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version) {
  /** @type {[string, string][]} */
  const files = shellPaths(repo).map((p) => {
    const file = FROM_ROOT.test(p) ? path.join(repo, p.slice(1)) : path.join(repo, "deck", p === "/" ? "index.html" : p.slice(1));
    return [p, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  });
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { v: 1, version, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: shell-hashes.mjs DIR"); process.exit(2); }
  try {
    const s = shellHashes(REPO, process.argv[3]);
    fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify(s));
    console.log(`shell.json lists ${s.files.length} files`);
  } catch (e) { console.error(`shell-hashes: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
