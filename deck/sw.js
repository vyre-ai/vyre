// The Deck's service worker: it makes the Deck installable on a phone and lets the shell open
// when the box is briefly out of reach. Network first, always; the cache is only a fallback for
// the Deck's own files.
//
// The one changed invariant (2026-09-27, gate-chat's ask for Chat's offline read, narrowed and
// approved by the lead — see docs/work/deck.md): threads.get and projects.list, and only those
// two, may be read back when the network is down. Every other /v1/ call — every write
// (approve/revise/reject/send/lease/answer among them), every vault.* or gate.* read, anything a
// model wrote as a secret — is still never cached, exactly as before. threads.get is only ever
// called for a thread someone actually opened (deck/views/projects.js, deck/chat/session.js),
// never a background poll, so caching it is already scoped to "sessions the user opened" without
// extra bookkeeping. The cache is capped by count and age (offlineTool below) and can be wiped
// with postMessage({type: "vyre:clear-offline"}) — there is no sign-out in Vyre yet, but this is
// ready for whatever that turns out to be.

const CACHE = "vyre-deck-1";
const OFFLINE_CACHE = "vyre-deck-offline-1";
const OFFLINE_TOOLS = new Set(["threads.get", "projects.list"]);
const OFFLINE_MAX = 20;                    // distinct calls kept, oldest evicted first
const OFFLINE_MAX_AGE_MS = 7 * 86_400_000; // a week

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE && k !== OFFLINE_CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("message", e => {
  if (e.data?.type === "vyre:clear-offline") e.waitUntil(caches.delete(OFFLINE_CACHE));
});

const offlineKey = (name, bodyText) => `/__offline__/${name}?${encodeURIComponent(bodyText)}`;

async function offlineIndex(cache) {
  const r = await cache.match("/__offline-index__");
  return r ? await r.json().catch(() => []) : [];
}
async function rememberOffline(name, bodyText, data) {
  const cache = await caches.open(OFFLINE_CACHE);
  const key = offlineKey(name, bodyText);
  await cache.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
  let idx = (await offlineIndex(cache)).filter(x => x.key !== key);
  idx.push({ key, at: Date.now() });
  const cutoff = Date.now() - OFFLINE_MAX_AGE_MS;
  idx = idx.filter(x => x.at >= cutoff);
  while (idx.length > OFFLINE_MAX) { const gone = idx.shift(); await cache.delete(gone.key); }
  await cache.put("/__offline-index__", new Response(JSON.stringify(idx), { headers: { "content-type": "application/json" } }));
}
async function readOffline(name, bodyText) {
  const cache = await caches.open(OFFLINE_CACHE);
  const r = await cache.match(offlineKey(name, bodyText));
  return r ? await r.json().catch(() => null) : null;
}

/** threads.get / projects.list only: try the network, remember a good answer, fall back offline. */
async function offlineTool(req, name) {
  const bodyText = await req.clone().text();
  try {
    const res = await fetch(req);
    if (res.ok) {
      const body = await res.clone().json().catch(() => null);
      if (body && "data" in body && !body.error) rememberOffline(name, bodyText, body.data).catch(() => {});
    }
    return res;
  } catch {
    const data = await readOffline(name, bodyText);
    if (data === null) return Response.error();
    return new Response(JSON.stringify({ data, offline: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

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
  if (url.origin !== location.origin) return;
  if (e.request.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    if (OFFLINE_TOOLS.has(name)) e.respondWith(offlineTool(e.request, name));
    // Every other tool call, read or write: untouched, network only. No cache, ever.
    return;
  }
  if (e.request.method !== "GET" || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/fixtures/") || url.pathname.startsWith("/onboard")) return;
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
