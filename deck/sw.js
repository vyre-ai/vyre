// The Deck's service worker: it makes the Deck installable on a phone, opens it at once from its
// own cache (the Deck's files, refreshed behind each use), and lets it open when the box is out of
// reach. Tool calls are the network's, always, but for the two offline reads below.
//
// The one changed invariant (2026-09-27, gate-chat's ask for Chat's offline read, narrowed and
// approved by the lead, see docs/work/deck.md): threads.get and projects.list, and only those
// two, may be read back when the network is down. Every other /v1/ call (every write
// (approve/revise/reject/send/lease/answer among them), every vault.* or gate.* read, anything a
// model wrote as a secret) is still never cached, exactly as before. threads.get is only ever
// called for a thread someone actually opened (deck/views/projects.js, deck/chat/session.js),
// never a background poll, so caching it is already scoped to "sessions the user opened" without
// extra bookkeeping. The cache is capped by count and age (offlineTool below) and can be wiped
// with postMessage({type: "vyre:clear-offline"}). There is no sign-out in Vyre yet, but this is
// ready for whatever that turns out to be.

// vyred writes the build it runs into BUILD as it serves this file (core/daemon serveDeck), so
// every release is a new sw.js, which the browser installs at once with a fresh cache: the
// release lands on this launch, not the next one. A checkout without a stamp serves "dev".
const BUILD = "dev";
const CACHE = "vyre-deck-8-" + BUILD;
const OFFLINE_CACHE = "vyre-deck-offline-1";
const OFFLINE_TOOLS = new Set(["threads.get", "projects.list"]);
const OFFLINE_MAX = 20;                    // distinct calls kept, oldest evicted first
const OFFLINE_MAX_AGE_MS = 7 * 86_400_000; // a week

// The installed phone app's shell, kept at install so a cold launch with the box out of reach
// still opens: the page, the shell's modules, and the five phone tabs. Everything else is kept
// the first time it is fetched (the fetch handler below), so the last views the user opened are
// there too. deck/test/sw.test.js checks every path here exists.
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/apple-touch-icon.png", "/favicon.svg",
  "/css/tokens.css", "/css/deck.css", "/css/buttons.css", "/css/marks.css", "/js/status-mark.js", "/js/rail.js", "/css/toast.css", "/js/toast.js", "/fonts/instrument-sans-latin.woff2", "/fonts/jetbrains-mono-latin.woff2", "/js/app.js", "/js/api.js", "/js/dom.js", "/js/icons.js", "/js/fmt.js", "/js/needs.js", "/js/editable.js",
  "/js/pwa.js", "/js/reconnect.js", "/js/keyboard.js", "/glass/util.js", "/js/health.js", "/js/machine.js", "/js/phone-setup.js", "/css/views/phone-setup.css", "/js/pair.js", "/css/pair.css", "/js/commands.js", "/js/first-passkey.js", "/js/assistant-setup.js", "/js/agent-create.js", "/js/empty-actions.js",
  "/js/now-phone.js", "/js/sheet.js", "/css/sheet.css", "/js/person.js", "/js/need-sheet.js", "/js/need-rows.js", "/js/capsule.js",
  "/views/now.js", "/css/views/now.css", "/views/projects.js", "/css/views/projects.css", "/views/chat.js", "/css/views/chat.css",
  "/views/find.js", "/css/views/find.css", "/views/agents.js", "/css/views/agents.css", "/views/needs.js", "/css/views/needs.css",
  "/chat/index.js", "/chat/session.js", "/chat/composer.js", "/chat/nav.js", "/chat/ask-item.js", "/chat/gate-item.js",
  "/chat/presence.js", "/chat/chat.css", "/chat/lib/routes.js", "/chat/lib/sessions.js", "/chat/lib/markdown.js",
  "/chat/lib/highlight.js", "/chat/lib/diff.js", "/chat/blocks.js", "/chat/question.js", "/chat/lib/blocks.js", "/chat/lib/names.js",
  "/chat/lib/answers.js", "/chat/newsession.js", "/chat/folders.js", "/chat/term.js", "/chat/term.css", "/chat/lib/term-link.js",
  "/chat/live-text.js", "/chat/core/session-state.js", "/chat/core/tool-detail.js", "/chat/core/grouping.js", "/chat/core/pace.js",
  "/chat/window-view.js", "/chat/core/window.js", "/chat/pickers.js", "/chat/tray.js", "/chat/core/composer-state.js",
  "/chat/core/caps.js", "/chat/core/commands.js", "/chat/core/match.js", "/chat/plan-card.js", "/chat/core/plan.js", "/chat/tip-line.js",
  "/core/resilience/stream.js", "/core/resilience/sse.js", "/core/resilience/backoff.js", "/core/resilience/outbox.js", "/core/resilience/web.js"];

self.addEventListener("install", e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // One missing file must not stop the install; the rest are still worth having.
  await Promise.all(SHELL.map(p => fetch(p, { cache: "no-cache" }).then(r => r.ok ? cache.put(p, r) : null).catch(() => null)));
  await self.skipWaiting();
})()));
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
// this runs. It is only ever {kind, title, path, tag, at}, never a held item's words or an
// ask's details, by design (core/push). Everything past the title is fetched after the tap, the
// same as every other surface.
const BODY = { ask: "Waiting on your answer.", draft: "Held at the Gate.", watch: "Finished.", lesson: "A lesson needs you.", test: "A test notification." };
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch {}
  // A planner ring answered elsewhere: close its notification here. A push that shows nothing is
  // penalised (WebKit drops the subscription after a few, Chrome warns), so it shows a silent one
  // under the same tag, which replaces the ring, and then closes every one with that tag.
  if (d.kind === "planner-ack") {
    const tag = String(d.tag || "");
    e.waitUntil((async () => {
      await self.registration.showNotification("Vyre", { body: "Answered.", tag, silent: true, data: { path: "/now" }, icon: "/icon-192.png", badge: "/icon-192.png" });
      for (const n of await self.registration.getNotifications({ tag })) n.close();
    })());
    return;
  }
  const title = d.title || "Vyre";
  // body is there only for a planner item the user chose to label on the lock screen (push.settings planner_label).
  // Shown even when the app is open and focused: iOS requires every push to show one.
  const shown = self.registration.showNotification(title, {
    body: d.body || BODY[d.kind] || "", tag: d.tag || d.kind || "vyre", data: { path: d.path || "/now" },
    icon: "/icon-192.png", badge: "/icon-192.png",
  });
  // Something waits on the person: a dot on the app's icon (the app sets the count when it opens).
  const dot = d.kind === "ask" || d.kind === "draft" ? Promise.resolve().then(() => self.navigator?.setAppBadge?.()).catch(() => {}) : null;
  // A test push with a receipt (push.test receipt: true): once it is shown, tell the box, so
  // `vyre phone add` can tick "a notification reached this phone". The nonce is all it sends.
  const receipt = typeof d.receipt === "string" ? d.receipt : "";
  const posted = receipt ? Promise.resolve(shown).then(() => fetch("/v1/tools/push.receipt", { method: "POST",
    headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify({ receipt }), credentials: "same-origin" }).catch(() => {})) : null;
  e.waitUntil(Promise.all([shown, dot, posted]));
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
  // Pages of their own, never the shell: onboarding, and the person's sign-in (/person/signin).
  // /app/ is the one app's own export with its own worker (scope /app/): never answer for it,
  // or a first visit there would get the Deck's shell.
  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) return;
  if (e.request.method !== "GET" || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/fixtures/") || url.pathname.startsWith("/onboard") || url.pathname.startsWith("/person/")) return;
  // The Deck's own files: from the cache at once, and fetched behind it so the next launch has
  // whatever changed (stale-while-revalidate). A phone on the tailnet would otherwise wait a round
  // trip per module on every tab it opens. Every page address is the one shell, index.html.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = e.request.mode === "navigate" ? "/" : e.request;
    const hit = await cache.match(key);
    const fresh = fetch(e.request).then(res => {
      if (res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    try { return await fresh; } catch { return Response.error(); }
  })());
});
