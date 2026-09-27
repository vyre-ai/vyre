// @ts-check
// sw: the service worker that holds app.vyre.run's fixed loader (ADR 0026 section 10, point 4). A
// classic script, not a module, so every browser with service workers runs it. release.js stamps
// the Vyre release public key below.
//
// Install checks the loader's signed manifest (/release-manifest.json and .sig) and every file's
// hash, and refuses a release older than the one it holds, so an asset changed at the CDN or a
// rolled-back loader never installs. Fetches for the loader come from the pinned cache;
// /v/<sha>/ folders are content-addressed and checked by the loader under SRI, so they are cached
// as fetched. The honest limit: the browser refetches this script at least daily, so an origin
// that turns hostile can replace the worker itself.

/* global self, caches, clients */
const RELEASE_PUB = "{{RELEASE_PUB}}";
const META = "vyre-meta";
const LOADER = "vyre-loader-";
const FOLDERS = "vyre-folders";

const b64u = s => Uint8Array.from(atob(String(s).trim().replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).trim().length + 3) % 4)), c => c.charCodeAt(0));
const hexOf = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
const sri = async bytes => `sha384-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", bytes))))}`;
const semver = r => (/^(\d+)\.(\d+)\.(\d+)$/.exec(r) || []).slice(1).map(Number);
const older = (a, b) => { const [x, y] = [semver(a), semver(b)]; return x.length !== 3 || (y.length === 3 && (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) < 0); };

async function active() {
  const r = await (await caches.open(META)).match("/__active");
  return r ? r.json() : null;
}

/** Check and cache a loader release. Resolves with { release, manifest } or throws with the reason. */
async function installLoader() {
  const get = async p => { const r = await fetch(p, { cache: "no-store" }); if (!r.ok) throw new Error(`${p} answered ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  const [bytes, sig] = await Promise.all([get("/release-manifest.json"), get("/release-manifest.sig")]);
  const key = await crypto.subtle.importKey("raw", b64u(RELEASE_PUB), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, b64u(new TextDecoder().decode(sig)), bytes))) throw new Error("the loader's signature does not verify");
  const m = JSON.parse(new TextDecoder().decode(bytes));
  const now = await active();
  if (now && older(m.release, now.release)) throw new Error(`refusing loader ${m.release}: ${now.release} is newer`);
  const cache = await caches.open(LOADER + m.release);
  for (const [p, h] of Object.entries(m.files || {})) {
    const body = await get("/" + p);
    if ((await sri(body)) !== h) throw new Error(`${p} does not match the signed loader`);
    await cache.put("/" + p, new Response(body, { headers: { "content-type": typeFor(p) } }));
  }
  const manifest = hexOf(await crypto.subtle.digest("SHA-256", bytes));
  await (await caches.open(META)).put("/__next", new Response(JSON.stringify({ release: m.release, manifest })));
  return { release: m.release, manifest };
}

const typeFor = p => (p.endsWith(".html") ? "text/html; charset=utf-8" : p.endsWith(".css") ? "text/css" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream");

async function activateLoader() {
  const meta = await caches.open(META);
  const next = await meta.match("/__next");
  if (!next) return;
  const n = await next.json();
  await meta.put("/__active", new Response(JSON.stringify(n)));
  await meta.delete("/__next");
  for (const name of await caches.keys()) if (name.startsWith(LOADER) && name !== LOADER + n.release) await caches.delete(name);
}

/** @param {Request} req @returns {Promise<Response>} */
async function respond(req) {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return fetch(req);
  if (url.pathname.startsWith("/v/")) {
    const folders = await caches.open(FOLDERS);
    const hit = await folders.match(url.pathname);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) await folders.put(url.pathname, r.clone());
    return r;
  }
  const a = await active();
  if (!a) return fetch(req);
  const cache = await caches.open(LOADER + a.release);
  const path = req.mode === "navigate" || url.pathname === "/" || url.pathname === "/pair" ? "/index.html" : url.pathname;
  return (await cache.match(path)) || fetch(req);
}

async function tell(message) {
  for (const c of await clients.matchAll({ includeUncontrolled: true })) c.postMessage(message);
}

if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("install", e => e.waitUntil(installLoader().catch(err => { tell({ type: "vyre-release", refused: true, why: String(err.message || err) }); throw err; })));
  self.addEventListener("activate", e => e.waitUntil(activateLoader().then(() => clients.claim())));
  self.addEventListener("fetch", e => e.respondWith(respond(e.request)));
  self.addEventListener("message", e => {
    if (e.data && e.data.type === "vyre-release?") e.waitUntil(active().then(a => e.source && e.source.postMessage({ type: "vyre-release", ...(a || {}) })));
  });
}
