// @ts-check
// lib/app-build.js: the web app build (apps/app/dist, served at /app/) is covered by the release's signature, like the module list. A release ships `appbuild.json` at the package root,
// `{ v: 1, release, base: "/app/", files: { "<path under dist>": "<sha256 hex>" } }`, as one more line of the signed SHA256SUMS (scripts/appbuild-manifest.mjs makes it from the UNPACKED
// tarball, so the hashes are of what a box holds). The daemon serves a file of the build only when its bytes hash to the listed value: a changed file, an added file, or a packaged build
// with no valid signed list is refused, because the Mac window and any browser run this code with the owner's authority (MW-5).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sumsSigned } from "./release-sig.js";

const MAX = 8_000_000;
const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * Read and verify the signed app list under a package root.
 * @param {string} root @param {string} [key] base64 SPKI DER, default the compiled release key
 * @returns {{ ok: true, release: string, files: Record<string, string> } | { ok: false, why: string }}
 */
export function readAppBuild(root, key) {
  /** @param {string} f */
  const read = f => { const p = path.join(root, f); const st = fs.lstatSync(p); if (!st.isFile() || st.size > MAX) throw new Error(`${f} is not a plain file`); return fs.readFileSync(p); };
  let sums, sig, list;
  try { sums = read("SHA256SUMS"); sig = read("SHA256SUMS.sig"); } catch { return { ok: false, why: "there is no signed SHA256SUMS beside this build" }; }
  try { list = read("appbuild.json"); } catch { return { ok: false, why: "there is no signed list of the app's files (appbuild.json)" }; }
  if (!sumsSigned(sums, sig.toString("utf8"), key)) return { ok: false, why: "SHA256SUMS is not signed by Vyre's release key" };
  const line = sums.toString("utf8").split("\n").map(l => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).find(m => m && m[2].replace(/^\.\//, "") === "appbuild.json");
  if (!line || line[1] !== sha256(list)) return { ok: false, why: "appbuild.json is not the file the signed SHA256SUMS lists" };
  try {
    const d = JSON.parse(list.toString("utf8"));
    if (d.v !== 1 || typeof d.release !== "string" || !d.files || typeof d.files !== "object") return { ok: false, why: "appbuild.json is not a list this build reads" };
    for (const [f, h] of Object.entries(d.files)) if (typeof f !== "string" || f.startsWith("/") || f.split("/").includes("..") || !/^[0-9a-f]{64}$/.test(String(h))) return { ok: false, why: "appbuild.json has a bad entry" };
    return { ok: true, release: d.release, files: d.files };
  } catch { return { ok: false, why: "appbuild.json cannot be read" }; }
}

/** The hash of every plain file under a dist folder, by path with forward slashes. @param {string} dist @returns {Record<string, string>} */
export function hashDist(dist) {
  /** @type {Record<string, string>} */ const out = {};
  const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) out[r] = sha256(fs.readFileSync(p));
    }
  };
  walk(dist, "");
  return out;
}

/** The tree hash of a file list: sha256 over the sorted `<path> <sha256>` lines. @param {Record<string, string>} files */
export function treeOf(files) { return sha256(Object.keys(files).sort().map(f => `${f} ${files[f]}\n`).join("")); }

/** The text of appbuild.json for a dist folder: the release version and counter (the same counter modules.json carries), every file's hash, and one hash over all of them. @param {string} dist @param {string} release @param {number} [counter] @param {Record<string, string>} [generated] files the daemon makes rather than reads (sw.js, the manifest), by name and text */
export function buildAppList(dist, release, counter = 0, generated = {}) {
  const files = hashDist(dist);
  for (const [name, text] of Object.entries(generated)) files[name] = sha256(text);
  return JSON.stringify({ v: 1, release, version: release, counter, base: "/app/", tree: treeOf(files), files }, null, 1) + "\n";
}

/**
 * The gate the daemon puts in front of every file of the build it serves. A development build (not packaged) is not gated. A packaged one needs a valid signed list (loaded once, kept for
 * the life of the process: the list sits root-owned in the image) and refuses any file that is not on it or whose bytes differ.
 * @param {{ root: string, packaged: boolean, key?: string }} o
 * @returns {{ check(rel: string, bytes: Buffer): null | { code: string, message: string } }}
 */
export function appGate({ root, packaged, key }) {
  /** @type {ReturnType<typeof readAppBuild> | null} */ let list = null;
  return {
    check(rel, bytes) {
      if (!packaged) return null;
      if (!list) list = readAppBuild(root, key);
      if (!list.ok) return { code: "app_build_unsigned", message: `the app is not served: ${list.why}` };
      const want = list.files[rel.split(path.sep).join("/")];
      if (!want) return { code: "app_build_unlisted", message: "the app is not served: this file is not part of the signed build" };
      if (want !== sha256(bytes)) return { code: "app_build_changed", message: "the app is not served: this file differs from the signed build" };
      return null;
    },
  };
}
