// @ts-check
// The one app (ADR 0027) at /app/: the web export of apps/app (`expo export -p web`, into
// apps/app/dist, built by CI and packed into vyre.tgz, never committed), served beside the Deck.
// It is a single-page app, so any /app/<route> that is not a file gets dist/index.html. Two
// files are made here rather than read from dist: /app/sw.js (core/daemon/app-sw.js with the
// export's precache list and build filled in) and, when the export has none, the manifest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { swWithBuild } from "./build.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const APP_DIST = path.join(REPO, "apps", "app", "dist");
const DECK_MANIFEST = path.join(REPO, "deck", "manifest.webmanifest");
const WORKER = path.join(HERE, "app-sw.js");
const PRECACHE_MAX = 2000;

export const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json" };
// The same policy as the Deck's files (core/daemon/index.js serveDeck).
export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** @param {import("node:http").ServerResponse} res */
function send(res, /** @type {number} */ status, /** @type {any} */ body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isDir(/** @type {string} */ p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(/** @type {string} */ p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/**
 * /app/sw.js: the template with PRECACHE from dist/precache.json (only "/app/" paths, at most
 * 2000, /app/index.html always among them) and BUILD from its build, else this vyred's build.
 * @param {{ dir?: string, template?: string, build?: import("./build.js").Build }} [opts]
 */
export function appWorker({ dir = APP_DIST, template, build } = {}) {
  let src = template ?? fs.readFileSync(WORKER, "utf8");
  /** @type {any} */
  let pre = {};
  try { pre = JSON.parse(fs.readFileSync(path.join(dir, "precache.json"), "utf8")) || {}; } catch {}
  const files = (Array.isArray(pre.files) ? pre.files : [])
    .filter((/** @type {unknown} */ f) => typeof f === "string" && f.startsWith("/app/") && !f.split("/").includes("..") && f.length < 1024);
  const list = [...new Set(["/app/index.html", ...files])].slice(0, PRECACHE_MAX);
  src = src.replace("const PRECACHE = [];", () => `const PRECACHE = ${JSON.stringify(list)};`);
  const id = typeof pre.build === "string" ? pre.build.replace(/[^\w.-]/g, "").slice(0, 64) : "";
  return id ? src.replace('const BUILD = "dev";', () => `const BUILD = ${JSON.stringify(id)};`) : swWithBuild(src, build);
}

/** The export's own manifest, else one for /app/ in the Deck's colours and icons. */
export function appManifest({ dir = APP_DIST, deckManifest = DECK_MANIFEST } = {}) {
  const own = path.join(dir, "manifest.webmanifest");
  if (isFile(own)) return fs.readFileSync(own, "utf8");
  /** @type {any} */
  let deck = {};
  try { deck = JSON.parse(fs.readFileSync(deckManifest, "utf8")); } catch {}
  return JSON.stringify({
    id: "/app/", name: "Vyre", short_name: "Vyre", start_url: "/app/", scope: "/app/", display: "standalone",
    background_color: deck.background_color || "#0E0D0C", theme_color: deck.theme_color || "#0E0D0C",
    icons: (deck.icons || []).map((/** @type {any} */ i) => ({ ...i, src: new URL(i.src, "http://vyred/").pathname })),
  }, null, 2);
}

/**
 * GET /app and /app/*. /app is a 301 to /app/. With no dist on this machine every path is
 * 404 no_app. Nothing outside dist is ever served, whatever the path says.
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {{ dir?: string, deckManifest?: string, build?: import("./build.js").Build }} [opts]
 */
export function serveApp(res, pathname, { dir: d = APP_DIST, deckManifest, build } = {}) {
  const dir = path.resolve(d);
  if (pathname === "/app") { res.writeHead(301, { location: "/app/", "cache-control": "no-cache" }); return res.end(); }
  if (!isDir(dir)) return send(res, 404, { error: { code: "no_app", message: "the app is not built on this machine" } });
  let rel;
  try { rel = decodeURIComponent(pathname).slice("/app/".length); } catch { return send(res, 404, { error: { code: "not_found", message: pathname } }); }
  const head = (/** @type {string} */ type, cache = "no-cache", extra = {}) => ({ "content-type": type, "cache-control": cache,
    "x-content-type-options": "nosniff", "content-security-policy": CSP, ...extra });
  if (rel === "sw.js") {
    res.writeHead(200, head("text/javascript", "no-cache", { "service-worker-allowed": "/app/" }));
    return res.end(appWorker({ dir, build }));
  }
  if (rel === "manifest.webmanifest") {
    res.writeHead(200, head(TYPES[".webmanifest"]));
    return res.end(appManifest({ dir, deckManifest }));
  }
  let file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 404, { error: { code: "not_found", message: pathname } });
  if (!isFile(file)) {
    // A missing hashed file is a stale page asking for an old build: a 404, not the shell with
    // a JavaScript name.
    if (rel.startsWith("_expo/")) return send(res, 404, { error: { code: "not_found", message: pathname } });
    file = path.join(dir, "index.html");
  }
  let buf;
  try { buf = fs.readFileSync(file); } catch { return send(res, 404, { error: { code: "no_app", message: "the app is not built on this machine" } }); }
  const hashed = pathname.startsWith("/app/_expo/static/") && file !== path.join(dir, "index.html");
  res.writeHead(200, head(TYPES[path.extname(file)] || "application/octet-stream", hashed ? IMMUTABLE : "no-cache"));
  res.end(buf);
}
