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

// Push: the payload is encrypted (aes128gcm) and already decrypted by the browser by the time
// this runs. It is only ever {kind, title, path, tag, at} — never a held item's words or an
// ask's details, by design (core/push). Everything past the title is fetched after the tap, the
// same as every other surface.
const BODY = { ask: "Waiting on your answer.", draft: "Held at the Gate.", watch: "Finished.", lesson: "A lesson needs you.", test: "A test notification." };
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch {}
  const title = d.title || "Vyre";
  e.waitUntil(self.registration.showNotification(title, {
    body: BODY[d.kind] || "", tag: d.tag || d.kind || "vyre", data: { path: d.path || "/now" },
    icon: "/icon-192.png", badge: "/icon-192.png",
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const path = e.notification.data?.path || "/now";
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      if (new URL(c.url).origin !== location.origin) continue;
      await c.focus();
      c.postMessage({ type: "vyre:navigate", path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});

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
