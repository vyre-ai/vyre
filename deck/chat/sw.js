// @ts-check
// Vyre Chat's service worker: the app shell cached for offline start, and read-only tool calls
// (threads.get, threads.list, projects.list, gate.held) cached so the last few sessions open
// read-only with no network. Never caches a write (send, approve, revise, reject, lease, answer):
// those must reach vyred or fail visibly, never appear to work from a stale cache.

const CACHE = "vyre-chat-v1";
const SHELL = ["/chat/", "/chat/app.js", "/chat/nav.js", "/chat/session.js", "/chat/composer.js",
  "/chat/gate-item.js", "/chat/ask-item.js", "/chat/chat.css", "/chat/manifest.webmanifest",
  "/chat/lib/markdown.js", "/chat/lib/highlight.js", "/chat/lib/diff.js",
  "/css/deck.css", "/js/api.js", "/js/dom.js", "/js/fmt.js", "/js/icons.js"];

const READ_ONLY = ["threads.get", "threads.list", "threads.asks", "projects.list", "projects.threads", "gate.held", "gate.get"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);

  // Read-only tool calls: try the network, cache a fresh copy, fall back to cache when offline.
  const tool = url.pathname.startsWith("/v1/tools/") ? decodeURIComponent(url.pathname.slice("/v1/tools/".length)) : null;
  if (req.method === "POST" && tool && READ_ONLY.includes(tool)) {
    e.respondWith(networkFirst(req));
    return;
  }
  // Everything else that isn't a tool call or the event stream: cache-first from the shell, else network.
  if (req.method === "GET" && !url.pathname.startsWith("/v1/")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});

async function networkFirst(req) {
  const body = await req.clone().text();
  // A synthetic GET URL as the cache key: Cache entries are matched by request, and a POST body
  // does not distinguish two entries on its own, so the input goes into the query string instead.
  const key = new Request(req.url + "?k=" + encodeURIComponent(body));
  try {
    const res = await fetch(req.clone());
    if (res.ok) { const c = await caches.open(CACHE); c.put(key, res.clone()); }
    return res;
  } catch {
    const c = await caches.open(CACHE);
    const hit = await c.match(key);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: { code: "offline", message: "no network and nothing cached for this" } }), { status: 503, headers: { "content-type": "application/json" } });
  }
}
