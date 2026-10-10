#!/usr/bin/env node
// scripts/sync-copies.mjs: code that must run where it cannot import from lib/ is GENERATED from lib/, never edited by hand. Today:
//   - local/hands-chrome-mac/extension/shared/sk/ (the credential shapes and the site-knowledge store; the extension runs inside Chrome),
//   - apps/app/src/store-core/credential-shapes.js (the phone app's redactor reads the same table),
//   - core/computers/image/computerd/ws.js (the computers image is built from that folder alone),
//   - relay/client/bytes.js (the Windows capsule ships relay/client/*.js on its own).
// They are byte copies behind a one-line header; test/generated-copies.test.js fails when one drifts.
//   node scripts/sync-copies.mjs                  write the copies
//   import { generatedFiles } from "./sync-copies.mjs"   what they should contain, as { path: text }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = "local/hands-chrome-mac/extension/shared/sk";
const SOURCES = ["lib/credential-shapes.js", "lib/site-knowledge.js"];
// lib/siteops/*.js (the learned website operations, ported methods and the one learner) is pure and runs in the extension too: it is copied, one folder down, beside the site-knowledge copy that
// imports its spec, and the files the extension imports at its old paths (apilearn.js, redact.js) are generated from it as well, so one learner serves both.
const SITEOPS = [
  ...fs.readdirSync(path.join(ROOT, "lib/siteops")).filter(f => f.endsWith(".js") && !f.endsWith(".test.js") && f !== "fixtures.js"),
  ...fs.readdirSync(path.join(ROOT, "lib/siteops/kits")).filter(f => f.endsWith(".js") && !f.endsWith(".test.js")).map(f => `kits/${f}`),
];

/** @returns {Record<string, string>} destination path (relative to the repo) to the text it must hold */
export function generatedFiles() {
  /** @type {Record<string, string>} */ const out = {};
  for (const src of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, src), "utf8");
    out[`${DEST}/${path.basename(src)}`] = `// GENERATED from ${src} by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.\n${text}`;
  }
  for (const f of SITEOPS) {
    const text = fs.readFileSync(path.join(ROOT, "lib/siteops", f), "utf8");
    out[`${DEST}/siteops/${f}`] = `// GENERATED from lib/siteops/${f} by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.\n${text}`;
  }
  // The phone app's bundle cannot import from lib/ either: its redactor (screens/connections/model.ts) reads this copy of the table, so it hides every shape the table knows, not a short list of its own.
  const shapes = fs.readFileSync(path.join(ROOT, "lib/credential-shapes.js"), "utf8");
  out["apps/app/src/store-core/credential-shapes.js"] = `// GENERATED from lib/credential-shapes.js by scripts/sync-copies.mjs (the app's bundle cannot import from lib/). Do not edit here: change the original and run the script.\n${shapes}`;
  const bytes = fs.readFileSync(path.join(ROOT, "lib/bytes.js"), "utf8");
  out["relay/client/bytes.js"] = `// GENERATED from lib/bytes.js by scripts/sync-copies.mjs (the Windows capsule ships relay/client/*.js on its own, so this folder cannot import from lib/). Do not edit here.\n${bytes}`;
  const ws = fs.readFileSync(path.join(ROOT, "lib/ws.js"), "utf8");
  out["core/computers/image/computerd/ws.js"] = `// GENERATED from lib/ws.js by scripts/sync-copies.mjs (computerd is copied alone into the image at /opt/computerd and cannot import from outside its folder). Do not edit here.\n${ws}`;
  out[`${DEST}/VERSION`] = `generated from ${SOURCES.join(" and ")} by scripts/sync-copies.mjs; test/generated-copies.test.js fails on drift\n`;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(ROOT, DEST);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  for (const [p, text] of Object.entries(generatedFiles())) { fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }); fs.writeFileSync(path.join(ROOT, p), text); }
  console.log(`sync-copies: ${Object.keys(generatedFiles()).length} files written`);
}
