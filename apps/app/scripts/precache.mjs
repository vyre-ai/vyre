// After `expo export -p web`: dist/precache.json, what the pwa's generated /app/sw.js caches on
// install: {"build": "<id>", "files": ["/app/index.html", "/app/_expo/static/js/web/entry-<hash>.js", ...]}.
// Only index.html and the files whose names carry a content hash are listed, so a cached file
// never goes stale under the same name. The build id changes whenever any listed file does.
//
//   node scripts/precache.mjs [dist] [prefix]     defaults: dist, /app/  (prefix / for the root export)

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A name with a content hash in it: entry-<32 hex>.js, forward.<32 hex>.png, close-icon.<hash>@2x.png. */
const HASHED = /[.-][0-9a-f]{16,}(@\d+(\.\d+)?x)?\.[A-Za-z0-9]+$/;

/**
 * The paths to precache, from dist-relative file paths ("/" separated): index.html and every
 * hashed file, under `prefix`, sorted. Pure.
 * @param {string[]} files @param {string} [prefix]
 * @returns {string[]}
 */
export function precacheList(files, prefix = "/app/") {
  const pre = prefix.endsWith("/") ? prefix : prefix + "/";
  return files
    .map((f) => f.replace(/\\/g, "/").replace(/^\.?\//, ""))
    .filter((f) => f === "index.html" || HASHED.test(path.posix.basename(f)))
    // encodeURI, as a browser writes the path: "@" stays, so the worker's cache key matches the request.
    .map((f) => pre + encodeURI(f))
    .sort();
}

/**
 * The build id: the first 16 hex of SHA-256 over each listed path and its content's hash. Pure.
 * @param {{ path: string, sha256: string }[]} entries
 */
export function buildId(entries) {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${e.path}\n${e.sha256}\n`);
  return h.digest("hex").slice(0, 16);
}

/** @param {string} dir @returns {string[]} dist-relative paths */
function walk(dir, rel = "") {
  /** @type {string[]} */ const out = [];
  for (const d of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r));
    else if (d.isFile()) out.push(r);
  }
  return out;
}

/** Write <dist>/precache.json; returns what it wrote. @param {string} dist @param {string} [prefix] */
export function writePrecache(dist, prefix = "/app/") {
  const files = walk(dist).filter((f) => f !== "precache.json");
  const list = precacheList(files, prefix);
  const pre = prefix.endsWith("/") ? prefix : prefix + "/";
  const entries = list.map((p) => {
    const rel = decodeURI(p.slice(pre.length));
    return { path: p, sha256: createHash("sha256").update(readFileSync(path.join(dist, rel))).digest("hex") };
  });
  // base: where this export is served, "/app" or "" (the root); the daemon reads it (core/daemon/app.js appBase).
  const out = { build: buildId(entries), base: pre === "/" ? "" : pre.slice(0, -1), files: list };
  writeFileSync(path.join(dist, "precache.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(process.argv[2] ?? path.join(here, "..", "dist"));
  const r = writePrecache(dist, process.argv[3] ?? "/app/");
  console.log(`precache.json: build ${r.build}, ${r.files.length} files`);
}
