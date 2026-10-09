#!/usr/bin/env node
// scripts/sync-copies.mjs: code that must run where it cannot import from lib/ is GENERATED from lib/, never edited by hand. Today:
//   - local/hands-chrome-mac/extension/shared/sk/ (the credential shapes and the site-knowledge store; the extension runs inside Chrome),
//   - core/computers/image/computerd/ws.js (the computers image is built from that folder alone).
// They are byte copies behind a one-line header; test/generated-copies.test.js fails when one drifts.
//   node scripts/sync-copies.mjs                  write the copies
//   import { generatedFiles } from "./sync-copies.mjs"   what they should contain, as { path: text }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = "local/hands-chrome-mac/extension/shared/sk";
const SOURCES = ["lib/credential-shapes.js", "lib/site-knowledge.js"];

/** @returns {Record<string, string>} destination path (relative to the repo) to the text it must hold */
export function generatedFiles() {
  /** @type {Record<string, string>} */ const out = {};
  for (const src of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, src), "utf8");
    out[`${DEST}/${path.basename(src)}`] = `// GENERATED from ${src} by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.\n${text}`;
  }
  const ws = fs.readFileSync(path.join(ROOT, "lib/ws.js"), "utf8");
  out["core/computers/image/computerd/ws.js"] = `// GENERATED from lib/ws.js by scripts/sync-copies.mjs (computerd is copied alone into the image at /opt/computerd and cannot import from outside its folder). Do not edit here.\n${ws}`;
  out[`${DEST}/VERSION`] = `generated from ${SOURCES.join(" and ")} by scripts/sync-copies.mjs; test/generated-copies.test.js fails on drift\n`;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(ROOT, DEST);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  for (const [p, text] of Object.entries(generatedFiles())) { fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }); fs.writeFileSync(path.join(ROOT, p), text); }
  console.log(`sync-copies: ${Object.keys(generatedFiles()).length} files written`);
}
