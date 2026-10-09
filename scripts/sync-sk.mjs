#!/usr/bin/env node
// scripts/sync-sk.mjs: the extension's copy of the credential shapes and the site-knowledge store (local/hands-chrome-mac/extension/shared/sk/) is GENERATED from lib/, never edited by hand. The extension
// runs inside Chrome and cannot import from lib/, so it carries byte copies behind a one-line header; test/sk-sync.test.js fails when they drift.
//   node scripts/sync-sk.mjs            write the copies
//   import { skFiles } from "./sync-sk.mjs"   what they should contain, as { path: text }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = "local/hands-chrome-mac/extension/shared/sk";
const SOURCES = ["lib/credential-shapes.js", "lib/site-knowledge.js"];

/** @returns {Record<string, string>} destination path (relative to the repo) to the text it must hold */
export function skFiles() {
  /** @type {Record<string, string>} */ const out = {};
  for (const src of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, src), "utf8");
    out[`${DEST}/${path.basename(src)}`] = `// GENERATED from ${src} by scripts/sync-sk.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.\n${text}`;
  }
  out[`${DEST}/VERSION`] = `generated from ${SOURCES.join(" and ")} by scripts/sync-sk.mjs; test/sk-sync.test.js fails on drift\n`;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(ROOT, DEST);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  for (const [p, text] of Object.entries(skFiles())) { fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }); fs.writeFileSync(path.join(ROOT, p), text); }
  console.log(`sync-sk: ${Object.keys(skFiles()).length} files written to ${DEST}`);
}
