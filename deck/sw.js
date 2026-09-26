// The Deck's service worker: it makes the Deck installable on a phone and lets the shell open
// when the box is briefly out of reach. Network first, always; the cache is only a fallback for
// the Deck's own files. API calls (/v1/) and events are never cached, so nothing a tool returned
// is ever kept on the device.

const CACHE = "vyre-deck-1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/fixtures/") || url.pathname.startsWith("/onboard")) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === "navigate") return (await caches.match("/")) || Response.error();
      return Response.error();
    }
  })());
});
