#!/usr/bin/env node
// gen-glass-page: the Glass screen page as ONE html file the phone's WebView can load with no address (apps/app/assets/glass/frame.html, an app asset the screen reads when it first needs it). On the phone away from the server the WebView has no box origin to load
// frame.html and its scripts from, so the page (frame.js, the vendored noVNC and input.js) is bundled into a single script and inlined. Generated, never edited:
//   node scripts/gen-glass-page.mjs            write it
//   node scripts/gen-glass-page.mjs --check    exit 1 if it is stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "apps/app/src/glass");
const VENDOR = path.join(ROOT, "apps/app/vendor/glass");
export const OUT = "apps/app/assets/glass/frame.html";

/** @returns {Promise<string>} the page */
export async function generate() {
  const esbuild = await import("esbuild-wasm");
  await esbuild.initialize({});
  const built = await esbuild.build({
    entryPoints: [path.join(SRC, "frame.js")], absWorkingDir: ROOT, bundle: true, format: "esm", write: false, target: "es2022", legalComments: "none", logLevel: "silent",
    // frame.js imports ./novnc/... and ./input.js, which the web build copies beside it from the vendored folder
    plugins: [{ name: "glass-vendor", setup(b) { b.onResolve({ filter: /^\.\/(novnc\/|input\.js)/ }, a => ({ path: path.join(VENDOR, a.path.replace(/^\.\//, "")) })); } }],
  });
  const script = built.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const html = fs.readFileSync(path.join(SRC, "frame.html"), "utf8").replace(/<script type="module" src="\.\/frame\.js"><\/script>/, () => `<script type="module">${script}</script>`);
  if (!html.includes(script)) throw new Error("frame.html no longer names ./frame.js as its module script");
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await generate();
  const file = path.join(ROOT, OUT);
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (have !== text) { console.error(`${OUT} is stale: run node scripts/gen-glass-page.mjs`); process.exit(1); }
    console.log(`${OUT} is current`);
  } else { fs.writeFileSync(file, text); console.log(`wrote ${OUT} (${text.length} bytes)`); }
  process.exit(0);
}
