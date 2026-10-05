// The one app's service worker (ADR 0027), scope /app/ (or / when config app.root serves the app at the root,
// BASE ""). vyred serves this file at <BASE>/sw.js (core/daemon/app.js appWorker) with BASE, PRECACHE and BUILD
// filled in from the app's export (precache.json), so every build is a new worker with a fresh cache. It never
// answers for anything outside the app: at /app/ the Deck at / keeps its own worker (deck/sw.js); at the root the
// box's own paths (DENY) are left alone; and no /v1/ call is ever cached here. Self-contained on purpose: a worker cannot share the Deck's
// modules, and this one must run before anything else loads.

const BASE = "/app";
const PRECACHE = [];
const BUILD = "dev";
// At the root the app shares the origin with the box's own paths, which are never the app's.
const DENY = ["/v1", "/onboard", "/person", "/release", "/kernel", "/lib", "/.well-known"];
const inApp = p => BASE ? p === BASE || p.startsWith(BASE + "/") : !DENY.some(d => p === d || p.startsWith(d + "/"));
const CACHE = "vyre-app-" + BUILD;
const SHELL = BASE + "/index.html";
// Hashed by the export, so a file there never changes under its name.
const STATIC = BASE + "/_expo/static/";

self.addEventListener("install", e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // One missing file must not stop the install; the rest are still worth having.
  await Promise.all(PRECACHE.map(p => fetch(p, { cache: "no-cache" }).then(r => r.ok ? cache.put(p, r) : null).catch(() => null)));
  await self.skipWaiting();
})()));

self.addEventListener("activate", e => e.waitUntil((async () => {
  // Only this worker's own older caches. The Deck's ("vyre-deck-*") are the Deck's.
  for (const k of await caches.keys()) if (k.startsWith("vyre-app-") && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

/** A notification's path as an address in the app: "/needs/x" is "/app/needs/x" (unchanged at the root). */
function appPath(p) {
  const s = typeof p === "string" && p.startsWith("/") ? p : "/now";
  return !BASE || s === BASE || s.startsWith(BASE + "/") ? s : BASE + s;
}

// Push: the same payload as the Deck's worker, {kind, title, path, tag, at} and for a labelled
// planner ring a body, never a held item's words or an ask's details (core/push).
const BODY = { ask: "Waiting on your answer.", draft: "Held at the Gate.", watch: "Finished.", lesson: "A lesson needs you.", test: "A test notification." };
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch {}
  // A planner ring answered elsewhere: show a silent one under the same tag (a push that shows
  // nothing is penalised), then close every one with that tag.
  if (d.kind === "planner-ack") {
    const tag = String(d.tag || "");
    e.waitUntil((async () => {
      await self.registration.showNotification("Vyre", { body: "Answered.", tag, silent: true, data: { path: BASE + "/now" }, icon: "/icon-192.png", badge: "/icon-192.png" });
      for (const n of await self.registration.getNotifications({ tag })) n.close();
    })());
    return;
  }
  const shown = self.registration.showNotification(d.title || "Vyre", {
    body: d.body || BODY[d.kind] || "", tag: d.tag || d.kind || "vyre", data: { path: appPath(d.path) },
    icon: "/icon-192.png", badge: "/icon-192.png",
  });
  // Something waits on the person: a dot on the app's icon (the app sets the count when it opens).
  const dot = d.kind === "ask" || d.kind === "draft" ? Promise.resolve().then(() => self.navigator?.setAppBadge?.()).catch(() => {}) : null;
  e.waitUntil(Promise.all([shown, dot]));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const path = appPath(e.notification.data?.path);
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      const u = new URL(c.url);
      if (u.origin !== location.origin || !inApp(u.pathname)) continue;
      await c.focus();
      c.postMessage({ type: "vyre:navigate", path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== "GET" || !inApp(url.pathname) || url.pathname === BASE + "/sw.js") return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Every page address is the one shell: from the cache first, else the network.
    const key = req.mode === "navigate" ? SHELL : req;
    const keep = res => { if (res.ok && res.type === "basic") cache.put(key, res.clone()).catch(() => {}); return res; };
    const hit = await cache.match(key);
    if (req.mode === "navigate" || url.pathname.startsWith(STATIC)) {
      if (hit) return hit;
      try { return keep(await fetch(req)); } catch { return Response.error(); }
    }
    // Other app files (icons, fonts, the manifest): from the cache at once, refreshed behind it.
    const fresh = fetch(req).then(keep);
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    try { return await fresh; } catch { return Response.error(); }
  })());
});
