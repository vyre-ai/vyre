// @ts-check
// worker: app.vyre.run is retired. The Vyre app on the web is web.vyre.run (relay/web), the same app as the Mac, Windows and Android apps, so this host only sends a person on to it.
// Every GET and HEAD gets a permanent redirect to web.vyre.run (a phone's old join or pair link goes to the route it meant; the URL fragment is kept by the browser). /sw.js is the one
// file it serves: a worker that clears what the old loader cached, unregisters itself and moves any open window to web.vyre.run, so a phone that installed the old app does not keep it for ever.
// No state, no cookies, nothing about any server or any person, and no script that is not that one file.

export const TARGET = "https://web.vyre.run";

export const SECURITY = Object.freeze({
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

/** The old loader's service worker, replaced by one that takes the old app down on every phone and browser that holds it. */
export const KILL_SWITCH = `// app.vyre.run has moved to ${TARGET}. This worker removes the old app from this browser.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) await caches.delete(name);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate("${TARGET}/").catch(() => {});
  })());
});
`;

/**
 * Where an old address goes. The phone app's links (/app/join, /app/pair) and the loader's own routes (/join, /pair, /github-return, /onboard) keep their meaning; the old built files
 * (/app/..., /v/<sha>/...) and anything else go to the front door.
 * @param {URL} url
 */
export function destination(url) {
  const m = /^\/(?:app\/)?(join|pair|github-return|onboard)(\/[\w./@~%+=-]*)?$/.exec(url.pathname);
  const path = m && !url.pathname.includes("..") ? `/${m[1]}${m[2] || ""}` : "/";
  return `${TARGET}${path}${m ? url.search : ""}`;
}

/** @param {Response} r @param {string} cache */
function dress(r, cache) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  out.headers.set("cache-control", cache);
  out.headers.delete("set-cookie");
  return out;
}

export default {
  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return dress(new Response("method not allowed", { status: 405 }), "no-store");
    if (url.pathname === "/sw.js") return dress(new Response(req.method === "HEAD" ? null : KILL_SWITCH, { headers: { "content-type": "text/javascript; charset=utf-8" } }), "no-cache");
    return dress(new Response(null, { status: 308, headers: { location: destination(url) } }), "public, max-age=3600");
  },
};
