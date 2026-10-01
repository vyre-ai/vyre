#!/usr/bin/env node
// @ts-check
// setup-hashes: writes DIR/setup.json, the sha256 of everything the setup page serves ({ v: 1, files: [[path, hex], ...] }, sorted):
// every file under site/setup as it is served (/setup/<name>, the index at /setup/), and the two install scripts, /i (scripts/install-box.sh)
// and /w (scripts/install-windows.ps1 when it exists). The release runs this into dist/ BEFORE the SHA256SUMS step, so SHA256SUMS lists
// setup.json and the one release signature covers it: what vyre.run serves for setup and the install line is checkable against the release
// (scripts/check-served.mjs does the check). Run after scripts/build-site.sh, which makes the copies of the relay client, tokens, fonts
// and the Deck pieces under site/setup.
//
//   node scripts/setup-hashes.mjs DIR

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
/** Files the page never serves to a person (tests, a staging override). */
const skip = (/** @type {string} */ rel) => /\.test\.js$|(^|\/)config\.json$|(^|\/)\.|(^|\/)node_modules\//.test(rel);

/** @param {string} [repo] @returns {{ v: 1, files: [string, string][] }} */
export function setupHashes(repo = REPO) {
  const root = path.join(repo, "site", "setup");
  /** @type {[string, string][]} */ const files = [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || skip(r)) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push([r === "index.html" ? "/setup/" : `/setup/${r}`, sha(fs.readFileSync(path.join(dir, e.name)))]);
    }
  };
  if (!fs.existsSync(root)) throw new Error("site/setup is missing: run scripts/build-site.sh first");
  walk(root, "");
  for (const [p, f] of /** @type {[string, string][]} */ ([["/i", "scripts/install-box.sh"], ["/w", "scripts/install-windows.ps1"]])) {
    const file = path.join(repo, f);
    if (fs.existsSync(file)) files.push([p, sha(fs.readFileSync(file))]);
  }
  if (!files.some(([p]) => p === "/setup/") || !files.some(([p]) => p === "/i")) throw new Error("the setup page or the install script is missing");
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { v: 1, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: setup-hashes.mjs DIR"); process.exit(2); }
  try {
    const s = setupHashes();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "setup.json"), JSON.stringify(s));
    console.log(`setup.json lists ${s.files.length} files`);
  } catch (e) { console.error(`setup-hashes: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
