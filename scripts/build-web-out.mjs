#!/usr/bin/env node
// @ts-check
// build-web-out: lays out what web.vyre.run serves from the release's sealed `app-out` (scripts/build-app-out.mjs), so the site is the
// release's own signed web export and never a branch build. It takes the build folder app-out/v/<sha>/, checks its signed manifest against
// the pinned release key and every file against the manifest, copies the files under web-out/app/ (the export is built with base URL /app),
// and writes web-out/vyre-build.json: the release, the folder, the manifest's sha256, the signature, the sha256 of index.html, and the CSP
// hash of every inline script and style the page carries (relay/web/worker.js builds its Content-Security-Policy from them).
//
//   node scripts/build-web-out.mjs [--app-out app-out] [--out web-out] [--pub <base64 spki or raw key>]
// --pub is for tests (a throwaway key); a real run uses the RELEASE_KEY pinned in core/vyre-core/release.js and refuses the placeholder.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "../relay/app/release.js";
import { MANIFEST, SIGNATURE } from "../relay/app/manifest.js";
import { PLACEHOLDER } from "./check-release-key.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The CSP hash source of a block's exact text. @param {string} text */
export const cspHash = text => `sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}`;

/** The hashes of every inline <script> and <style> of a page (a script with a src is not inline). @param {string} html */
export function inlineHashes(html) {
  const scripts = [], styles = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\ssrc\s*=/.test(m[1]) && m[2].trim()) scripts.push(cspHash(m[2]));
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1].trim()) styles.push(cspHash(m[1]));
  return { scriptHashes: [...new Set(scripts)], styleHashes: [...new Set(styles)] };
}

/** The pinned release public key as 32 raw bytes, refusing the placeholder. */
export function pinnedKey(file = path.join(ROOT, "core", "vyre-core", "release.js")) {
  const spki = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(file, "utf8"))?.[1];
  if (!spki) throw new Error("no RELEASE_KEY in core/vyre-core/release.js");
  if (spki === PLACEHOLDER) throw new Error("RELEASE_KEY is still the placeholder: nothing signed by it is a release");
  return new Uint8Array(Buffer.from(spki, "base64").subarray(-32));
}

/**
 * @param {{ appOut: string, out: string, pub?: Uint8Array }} o
 * @returns {Promise<{ release: string, folder: string, manifest: string, index: string, files: number }>}
 */
export async function buildWebOut({ appOut, out, pub = pinnedKey() }) {
  const vdir = path.join(appOut, "v");
  const folders = fs.existsSync(vdir) ? fs.readdirSync(vdir).filter(n => /^[a-f0-9]{40}$/.test(n)) : [];
  if (folders.length !== 1) throw new Error(`${appOut}/v must hold exactly one build, found ${folders.length}`);
  const src = path.join(vdir, folders[0]);
  const manifestSha = await verify(src, pub);
  if (manifestSha.slice(0, 40) !== folders[0]) throw new Error("the build folder is not named by its manifest");
  const manifest = JSON.parse(fs.readFileSync(path.join(src, MANIFEST), "utf8"));
  const indexBytes = fs.readFileSync(path.join(src, "index.html"));
  fs.rmSync(out, { recursive: true, force: true });
  const files = Object.keys(manifest.files);
  for (const f of [...files, MANIFEST, SIGNATURE]) {
    const to = path.join(out, "app", f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
  }
  const info = {
    release: manifest.release, folder: folders[0], manifest: manifestSha, signature: fs.readFileSync(path.join(src, SIGNATURE), "utf8").trim(),
    index: crypto.createHash("sha256").update(indexBytes).digest("hex"), ...inlineHashes(indexBytes.toString("utf8")),
  };
  fs.writeFileSync(path.join(out, "vyre-build.json"), JSON.stringify(info, null, 2) + "\n");
  return { release: info.release, folder: info.folder, manifest: manifestSha, index: info.index, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const flag = (/** @type {string} */ n, d = "") => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  try {
    const pub = flag("pub") ? new Uint8Array(Buffer.from(flag("pub"), "base64").subarray(-32)) : undefined;
    const r = await buildWebOut({ appOut: flag("app-out", "app-out"), out: flag("out", "web-out"), ...(pub ? { pub } : {}) });
    console.log(JSON.stringify(r));
  } catch (e) { console.error(`build-web-out: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
