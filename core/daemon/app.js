// @ts-check
// The one app (ADR 0027) at /app/: the web export of apps/app (`expo export -p web`, into
// apps/app/dist, built by CI and packed into vyre.tgz, never committed), served at / (or /app/).
// With config app.root it is served at / instead, from the same folder built with the root base
// (`npm run export:web:root`; precache.json names the base, appBase()). It is a single-page app, so any
// route that is not a file gets index.html. Two files are made here rather than read from the
// export: <base>/sw.js (core/daemon/app-sw.js with the base, precache list and build filled in)
// and, when the export has none, the manifest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { swWithBuild } from "./build.js";
import { appGate } from "../../lib/app-build.js";
import { isPackaged, PKG_ROOT } from "../../kernel/devbuild.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const APP_DIST = path.join(REPO, "apps", "app", "dist");
const WEB_MANIFEST = path.join(REPO, "web", "manifest.webmanifest");
const WORKER = path.join(HERE, "app-sw.js");
const PRECACHE_MAX = 2000;
// The signed list of the build's files (lib/app-build.js): a packaged daemon serves a file of /app/ only when it is on the release's signed list and its bytes match (MW-5).
const GATE = appGate({ root: PKG_ROOT, packaged: isPackaged() });

export const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json" };
// The same policy as web/'s files (core/daemon/index.js serveWeb).
export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'";
/**
 * The app's policy for a request to this host: the same, plus the right to frame this box's own preview addresses (pv-<id>.<this host>), and nothing else. A host that is not a plain name changes nothing.
 * @param {string | undefined} host the request's Host @param {string} [base] where Vyre's front is served (config appmods.base), when it is not this host
 */
export function cspFor(host, base) {
  const names = [...new Set([host, base].map(h => String(h || "").toLowerCase().replace(/:\d+$/, "")).filter(h => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)))];
  const src = [...names.map(h => `https://*.${h}`), "http://*.localhost:*"].join(" ");
  return CSP.replace("frame-ancestors 'none'", `frame-src 'self' ${src}; frame-ancestors 'none'`);
}
const IMMUTABLE = "public, max-age=31536000, immutable";

/** @param {import("node:http").ServerResponse} res */
function send(res, /** @type {number} */ status, /** @type {any} */ body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isDir(/** @type {string} */ p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(/** @type {string} */ p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** Where an export is served: the "base" its precache.json names ("/app" or "" for the root), "/app" when it names none. @param {string} [dir] */
export function appBase(dir = APP_DIST) {
  const hit = BASES.get(dir);
  if (hit && Date.now() - hit.at < 5000) return hit.base;
  let base = "/app";
  try { const b = JSON.parse(fs.readFileSync(path.join(dir, "precache.json"), "utf8")).base; if (b === "" || b === "/app") base = b; } catch {}
  BASES.set(dir, { at: Date.now(), base });
  return base;
}
/** @type {Map<string, { at: number, base: string }>} the last answer per folder, so a page of requests reads the file once */
const BASES = new Map();

/**
 * <base>/sw.js: the template with BASE, PRECACHE from precache.json (only paths under the base, at
 * most 2000, <base>/index.html always among them) and BUILD from its build, else this vyred's build.
 * base is "/app" or "" (the root).
 * @param {{ dir?: string, template?: string, build?: import("./build.js").Build, base?: string }} [opts]
 */
export function appWorker({ dir = APP_DIST, template, build, base = appBase(dir) } = {}) {
  let src = template ?? fs.readFileSync(WORKER, "utf8");
  /** @type {any} */
  let pre = {};
  try { pre = JSON.parse(fs.readFileSync(path.join(dir, "precache.json"), "utf8")) || {}; } catch {}
  const files = (Array.isArray(pre.files) ? pre.files : [])
    .filter((/** @type {unknown} */ f) => typeof f === "string" && f.startsWith(base + "/") && !f.split("/").includes("..") && f.length < 1024);
  const list = [...new Set([base + "/index.html", ...files])].slice(0, PRECACHE_MAX);
  src = src.replace('const BASE = "/app";', () => `const BASE = ${JSON.stringify(base)};`);
  src = src.replace("const PRECACHE = [];", () => `const PRECACHE = ${JSON.stringify(list)};`);
  const id = typeof pre.build === "string" ? pre.build.replace(/[^\w.-]/g, "").slice(0, 64) : "";
  return id ? src.replace('const BUILD = "dev";', () => `const BUILD = ${JSON.stringify(id)};`) : swWithBuild(src, build);
}

/** The export's own manifest, else one for the base in the web pages' colours and icons. */
export function appManifest({ dir = APP_DIST, webManifest = WEB_MANIFEST, base = appBase(dir) } = {}) {
  const own = path.join(dir, "manifest.webmanifest");
  if (isFile(own)) return fs.readFileSync(own, "utf8");
  /** @type {any} */
  let web = {};
  try { web = JSON.parse(fs.readFileSync(webManifest, "utf8")); } catch {}
  return JSON.stringify({
    id: base + "/", name: "Vyre", short_name: "Vyre", start_url: base + "/", scope: base + "/", display: "standalone",
    background_color: web.background_color || "#0E0D0C", theme_color: web.theme_color || "#0E0D0C",
    icons: (web.icons || []).map((/** @type {any} */ i) => ({ ...i, src: new URL(i.src, "http://vyred/").pathname })),
  }, null, 2);
}

/**
 * GET /app and /app/* (base "/app"), or any path the box does not own (base "", config app.root).
 * /app is a 301 to /app/. With no export on this machine every path is 404 no_app. Nothing outside
 * the export is ever served, whatever the path says.
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {{ csp?: string, dir?: string, webManifest?: string, base?: string, build?: import("./build.js").Build, gate?: { check(rel: string, bytes: Buffer): null | { code: string, message: string } } }} [opts]
 */
export function serveApp(res, pathname, { dir: d = APP_DIST, webManifest, base: b, build, gate = GATE, csp = CSP } = {}) {
  const dir = path.resolve(d);
  const base = b ?? appBase(dir);
  if (base && pathname === base) { res.writeHead(301, { location: base + "/", "cache-control": "no-cache" }); return res.end(); }
  if (!isDir(dir)) return send(res, 404, { error: { code: "no_app", message: "the app is not built on this machine" } });
  let rel;
  try { rel = decodeURIComponent(pathname).slice(base.length + 1); } catch { return send(res, 404, { error: { code: "not_found", message: pathname } }); }
  const head = (/** @type {string} */ type, cache = "no-cache", extra = {}) => ({ "content-type": type, "cache-control": cache,
    "x-content-type-options": "nosniff", "content-security-policy": csp, ...extra });
  if (rel === "sw.js") {
    // The two generated files are on the signed list too (MW-5): what this daemon makes must hash to what the release signed.
    const sw = appWorker({ dir, build, base });
    const refusedSw = gate.check("sw.js", Buffer.from(sw));
    if (refusedSw) return send(res, 503, { error: refusedSw });
    res.writeHead(200, head("text/javascript", "no-cache", { "service-worker-allowed": base + "/" }));
    return res.end(sw);
  }
  if (rel === "manifest.webmanifest") {
    const mf = appManifest({ dir, webManifest, base });
    const refusedMf = gate.check("manifest.webmanifest", Buffer.from(mf));
    if (refusedMf) return send(res, 503, { error: refusedMf });
    res.writeHead(200, head(TYPES[".webmanifest"]));
    return res.end(mf);
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
  const refused = gate.check(path.relative(dir, file), buf);
  if (refused) return send(res, 503, { error: refused });
  const hashed = pathname.startsWith(base + "/_expo/static/") && file !== path.join(dir, "index.html");
  res.writeHead(200, head(TYPES[path.extname(file)] || "application/octet-stream", hashed ? IMMUTABLE : "no-cache"));
  res.end(buf);
}

/**
 * The two files that let the iPhone and Android apps open https join and pair links at this origin (app-wire's verified links): /.well-known/apple-app-site-association and
 * /.well-known/assetlinks.json for the app sh.vyre.app, paths /app/join and /app/pair. The signing identities are not in the code: the Apple team id comes from VYRE_APPLE_TEAM_ID and the
 * Android certificate fingerprint(s) from VYRE_ANDROID_CERT_SHA256 (comma separated, colon-hex), set where the app origin is deployed. Missing, the file is absent (a 404), never a guess.
 * @param {string} pathname @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function associationFile(pathname, env = process.env) {
  const APP = "sh.vyre.app";
  if (pathname === "/.well-known/apple-app-site-association") {
    const team = String(env.VYRE_APPLE_TEAM_ID || "");
    if (!/^[A-Z0-9]{10}$/.test(team)) return null;
    return JSON.stringify({ applinks: { details: [{ appIDs: [`${team}.${APP}`], components: [{ "/": "/app/join*" }, { "/": "/app/pair*" }] }] } }, null, 2);
  }
  if (pathname === "/.well-known/assetlinks.json") {
    const fps = String(env.VYRE_ANDROID_CERT_SHA256 || "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean);
    if (!fps.length || !fps.every(x => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x))) return null;
    return JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: APP, sha256_cert_fingerprints: fps } }], null, 2);
  }
  return null;
}
