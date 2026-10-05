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
const VERSION_CACHE = "vyre-deck-shell-version"; // the highest signed release accepted; outlives each build
const HASHES_KEY = "/__shell-hashes";
const OFFLINE_TOOLS = new Set(["threads.get", "projects.list"]);
const OFFLINE_MAX = 20;                    // distinct calls kept, oldest evicted first
const OFFLINE_MAX_AGE_MS = 7 * 86_400_000; // a week

// The installed phone app's shell, kept at install so a cold launch with the box out of reach
// still opens: the page, the shell's modules, and the five phone tabs. Everything else is kept
// the first time it is fetched (the fetch handler below), so the last views the user opened are
// there too. deck/test/sw.test.js checks every path here exists.
// Reviewer N-H1 (30 Sep 2026, plans/pwa.md section 9): a relay-only phone runs the shell that
// ONE hosted origin serves (phone.vyre.run); a compromised or mis-deployed origin could serve
// different code to every paired phone at once with nothing catching it. So before this worker
// activates a new shell it checks the shell's own files against the RELEASE signature, the same
// one the Mac installer and `vyre update` check: SHA256SUMS.sig, base64 Ed25519 over
// "vyre-release-sums\n" + the exact bytes of SHA256SUMS (scripts/sign-manifest.mjs). SHA256SUMS
// lists shell.json (scripts/shell-hashes.mjs, run by the release before it signs), and shell.json
// lists the sha256 of every shell file. Three links, each checked: signature over SUMS, SUMS line
// for shell.json, shell.json line for each fetched file. The three files are served from
// /release/ (deck/release/, put there by the release: vyre update and the phone.vyre.run deploy).
//
// RELEASE_KEY is public (the same constant as core/vyre-core/release.js, kept equal by
// deck/test/shell-release-sw.test.js). SHELL_SIGNED is substituted true by core/daemon/build.js's
// swWithBuild when the release files are present; a dev checkout or testbox build has none, stays
// false, and this worker behaves as before. When it is true, a missing or wrong file refuses the
// new shell. Honest limit: sw.js itself comes from the same origin, so this catches a shell that
// differs from the release, not an origin that swaps this worker too; the HTTPS origin is the
// root for that. A browser without Ed25519 in WebCrypto (older Safari) cannot check and installs
// as before, with a console line.
// This file has no `import` (a classic worker), so the checks are written here; the test runs
// this function's own source in Node against a real release built by scripts/sign-manifest.mjs.
const RELEASE_KEY = "MCowBQYDK2VwAyEAKXSdujH7tO/gscXCJZmYCjB+Cv1sVlOfdgLNedMR7FU=";
const SHELL_SIGNED = false;

/** @param {ArrayBuffer} buf */
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
/**
 * The sha256 the release lists for a file. The page (index.html, served at "/" and on every
 * client route) carries its build id in a meta tag that vyred sets per build (core/daemon/build.js
 * htmlWithBuild); the release lists it as built, with "dev", so that one tag is put back first.
 * @param {string} path @param {ArrayBuffer} bytes
 */
async function sha(path, bytes) {
  if (path === "/" || path === "/index.html" || !/\.[a-z0-9]+$/i.test(path)) {
    const text = new TextDecoder().decode(bytes);
    if (text.includes('name="vyre-build"')) bytes = new TextEncoder().encode(text.replace(/(<meta name="vyre-build" content=")[^"]*(")/, "$1dev$2")).buffer;
  }
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
/** @param {string} b64 */
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verifies a fetched shell against the signed release. `files` is every file this install just
 * fetched, as `{ path, bytes: ArrayBuffer }`. Returns `{ ok, checked, why? }`: `checked: false`
 * means nothing to check on this build (unsigned checkout, or a browser that cannot verify);
 * `checked: true, ok: false` means the shell does not match the release and must not activate.
 * Complete: every path in `required` (the SHELL list but sw.js) must have been fetched and be
 * listed with a matching hash, so an origin cannot withhold a file. Version floor: shell.json
 * carries the release version and a lower one than `floor` (the highest accepted) is refused.
 * On success it also returns the listed hashes and the version, for the fetch handler and the floor.
 * @param {{ path: string, bytes: ArrayBuffer }[]} files @param {string[]} required @param {string} [floor]
 */
async function verifyShell(files, required, floor = "") {
  if (!SHELL_SIGNED) return { ok: true, checked: false };
  const get = async (/** @type {string} */ name) => {
    const r = await fetch("/release/" + name, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return r.arrayBuffer();
  };
  let sums, sig, shellJson;
  try { [sums, sig, shellJson] = await Promise.all([get("SHA256SUMS"), get("SHA256SUMS.sig"), get("shell.json")]); }
  catch (e) { return { ok: false, checked: true, why: "release files: " + /** @type {Error} */ (e).message }; }
  let key;
  try { key = await crypto.subtle.importKey("spki", fromBase64(RELEASE_KEY), { name: "Ed25519" }, false, ["verify"]); }
  catch { return { ok: true, checked: false, unsupported: true, why: "no Ed25519 here" }; }
  const prefix = new TextEncoder().encode("vyre-release-sums\n");
  const signed = new Uint8Array(prefix.length + sums.byteLength);
  signed.set(prefix); signed.set(new Uint8Array(sums), prefix.length);
  let sigOk = false;
  try {
    const text = new TextDecoder().decode(sig).trim();
    sigOk = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(text), signed);
  } catch { sigOk = false; }
  if (!sigOk) return { ok: false, checked: true, why: "bad signature" };
  const listed = new Map();
  for (const line of new TextDecoder().decode(sums).split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m) listed.set(m[2], m[1]);
  }
  if (listed.get("shell.json") !== hex(await crypto.subtle.digest("SHA-256", shellJson))) return { ok: false, checked: true, why: "shell.json is not the signed one" };
  let shell;
  try { shell = JSON.parse(new TextDecoder().decode(shellJson)); } catch { shell = null; }
  if (!shell || shell.v !== 1 || !Array.isArray(shell.files)) return { ok: false, checked: true, why: "shell.json malformed" };
  const known = new Map(shell.files);
  const version = typeof shell.version === "string" ? shell.version : "";
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, checked: true, why: "shell.json has no version" };
  if (floor && semverLess(version, floor)) return { ok: false, checked: true, why: `older than ${floor}` };
  const got = new Map(files.map(f => [f.path, f.bytes]));
  for (const p of required) {
    const want = known.get(p), bytes = got.get(p);
    if (!want) return { ok: false, checked: true, why: `not listed: ${p}` };
    if (!bytes) return { ok: false, checked: true, why: `not fetched: ${p}` };
    if (await sha(p, bytes) !== want) return { ok: false, checked: true, why: `hash mismatch: ${p}` };
  }
  return { ok: true, checked: true, files: shell.files, version };
}
/** a < b for x.y.z versions (a prerelease tail is ignored). @param {string} a @param {string} b */
function semverLess(a, b) {
  const n = (/** @type {string} */ v) => v.split(/[-+]/)[0].split(".").map(x => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/apple-touch-icon.png", "/favicon.svg",
  "/css/tokens.css", "/css/deck.css", "/css/buttons.css", "/css/tabbar.css", "/css/rows.css", "/css/tokens-v2.css", "/css/tokens-v3.css", "/css/ui.css", "/css/ui-views.css", "/css/ui-now.css", "/css/ui-project.css", "/ui/components/index.js", "/ui/screens.js", "/views/ui.js", "/ui/tokens-v3.js", "/ui/theme.js", "/css/kit.css", "/css/shell-v2.css", "/css/thread-row.css", "/css/avatar-card.css", "/js/avatar-card.js", "/js/message-details.js", "/js/thread-row.js", "/js/cmdbar.js", "/js/cmdbar-core.js", "/js/page-header.js", "/js/rename-field.js", "/js/states.js", "/js/rows.js", "/js/trace.js", "/js/chat-counts.js", "/css/marks.css", "/js/status-mark.js", "/js/rail.js", "/js/place-list.js", "/js/rail-mode.js", "/css/toast.css", "/js/toast.js", "/fonts/instrument-sans-latin.woff2", "/fonts/jetbrains-mono-latin.woff2", "/js/app.js", "/js/api.js", "/js/dom.js", "/js/icons.js", "/js/fmt.js", "/js/needs.js", "/js/editable.js",
  "/js/pwa.js", "/js/reconnect.js", "/js/theme-live.js", "/js/context-report.js", "/js/glass-mini.js", "/js/keyboard.js", "/glass/util.js", "/js/phone-setup.js", "/css/views/phone-setup.css", "/css/pair.css", "/js/commands.js", "/js/first-passkey.js", "/js/assistant-setup.js", "/js/agent-create.js", "/js/empty-actions.js", "/js/home.js", "/js/trust-ask.js", "/js/project-actions.js",
  "/js/now-phone.js", "/js/sheet.js", "/css/sheet.css", "/js/person.js", "/js/need-sheet.js", "/js/need-rows.js", "/js/capsule.js",
  "/js/avatars.js", "/js/build-check.js", "/js/platform.js", "/chat/lib/opened-here.js", "/js/github-repo-picker.js", "/lib/wink-code/identity.js", "/vendor/vyrecode/creature.js", "/vendor/vyrecode/characters.js", "/vendor/vyrecode/project.js", "/vendor/vyrecode/emblem.js", "/vendor/vyrecode/agent2.js", "/lib/wink-code/vyrecode2.js",
  "/lib/wink-code/geometry.js", "/lib/wink-code/payload.js", "/lib/wink-code/rs.js", "/lib/avatar-seed/index.js",
  "/views/now.js", "/css/views/now.css", "/views/quick.js", "/views/settings-spend.js", "/css/views/quick.css", "/views/projects.js", "/css/views/projects.css", "/views/chat.js", "/css/views/chat.css",
  "/views/find.js", "/views/artifact.js", "/css/views/find.css", "/js/enroll-grant.js", "/js/more.js", "/js/places.js", "/js/haptics.js", "/js/find-prefix.js", "/js/wipe.js", "/js/memory-ask.js", "/views/agents.js", "/css/views/agents.css", "/views/needs.js", "/css/views/needs.css",
  "/js/star-button.js", "/views/settings-accounts.js",
  "/chat/index.js", "/chat/session.js", "/chat/composer.js", "/chat/nav.js", "/chat/ask-item.js", "/chat/gate-item.js", "/chat/gate-lines.js",
  "/js/provider-mark.js", "/js/provider-art.js", "/chat/undo-sheet.js", "/chat/core/answer-with.js", "/chat/core/stop-words.js",
  "/chat/presence.js", "/chat/chat.css", "/chat/lib/routes.js", "/chat/lib/sessions.js", "/chat/lib/markdown.js",
  "/chat/lib/highlight.js", "/chat/lib/diff.js", "/chat/blocks.js", "/chat/question.js", "/chat/lib/blocks.js", "/chat/lib/names.js",
  "/chat/lib/answers.js", "/chat/newsession.js", "/chat/folders.js", "/chat/term.js", "/chat/term.css", "/chat/lib/term-link.js",
  "/chat/live-text.js", "/chat/core/session-state.js", "/chat/core/paste-spans.js", "/chat/tag-picker.js", "/chat/core/tool-detail.js", "/chat/core/grouping.js", "/chat/core/pace.js",
  "/chat/window-view.js", "/chat/core/window.js", "/chat/pickers.js", "/chat/tray.js", "/chat/core/composer-state.js", "/chat/core/suggest.js",
  "/chat/core/caps.js", "/chat/core/commands.js", "/chat/core/match.js", "/chat/plan-card.js", "/chat/core/plan.js", "/chat/tip-line.js",
  "/chat/core/images.js", "/chat/lightbox.js", "/chat/core/voice.js", "/js/mac-keys.js", "/chat/core/made.js", "/chat/cards/artifact-frame.js", "/chat/cards/artifact.css", "/chat/cards/artifact.js", "/chat/cards/calendar-event.css", "/chat/cards/calendar-event.js", "/chat/cards/charter-changed.css", "/chat/cards/charter-changed.js", "/chat/cards/confirmation.css", "/chat/cards/confirmation.js", "/chat/cards/diff-files.css", "/chat/cards/diff-files.js", "/chat/cards/draft.css", "/chat/cards/draft.js", "/chat/cards/email-thread.css", "/chat/cards/email-thread.js", "/chat/cards/file-preview.css", "/chat/cards/file-preview.js", "/chat/cards/index.js", "/chat/cards/kit.js", "/chat/cards/land.css", "/chat/cards/land.js", "/chat/cards/pr-review.css", "/chat/cards/pr-review.js", "/chat/cards/report.css", "/chat/cards/report.js", "/chat/cards/spend-capped.css", "/chat/cards/spend-capped.js", "/chat/cards/watcher.css", "/chat/cards/watcher.js", "/chat/cards/vault-used.css", "/chat/cards/vault-used.js", "/chat/cards/survey.css", "/chat/cards/survey.js",
  "/core/resilience/stream.js", "/core/resilience/sse.js", "/core/resilience/backoff.js", "/core/resilience/outbox.js", "/core/resilience/web.js"];

self.addEventListener("install", e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // One missing file must not stop the install; the rest are still worth having. Each response
  // is cloned so its bytes can be hashed for verifyShell() without consuming the copy cache.put
  // needs - a plain read would leave the other empty.
  const fetched = /** @type {{ path: string, bytes: ArrayBuffer }[]} */ ([]);
  await Promise.all(SHELL.map(async p => {
    let r;
    try { r = await fetch(p, { cache: "no-cache" }); } catch { return; }
    if (!r.ok) return;
    const forHash = r.clone();
    await cache.put(p, r);
    try { fetched.push({ path: p, bytes: await forHash.arrayBuffer() }); } catch {}
  }));
  const vc = SHELL_SIGNED ? await caches.open(VERSION_CACHE) : null;
  const floor = vc ? await (await vc.match("/version"))?.text().catch(() => "") || "" : "";
  const v = await verifyShell(fetched, SHELL.filter(p => p !== "/sw.js"), floor);
  if (v.checked && !v.ok) {
    // Fails closed: this new cache is discarded and skipWaiting() is never called, so the
    // browser keeps running whichever shell was already active (the old cache, the old worker) -
    // never a half-verified new one. Surfaced for whoever's own diagnostics can reach it; no UI
    // for this yet (app-design's queue), so a clear console line is the floor.
    console.error("vyre: shell release check failed, refusing this release:", v.why);
    await caches.delete(CACHE);
    return;
  }
  if (v.unsupported) {
    // No Ed25519 in this browser (older Safari): it cannot check. Never a "signed" worker with no
    // hash list: with a worker already running, refuse this install so that one keeps running;
    // with none (a first install), run as an unsigned shell, and the fetch handler sees no list.
    if (self.registration && self.registration.active) {
      console.error("vyre: this browser cannot verify the release signature; keeping the current shell");
      await caches.delete(CACHE);
      return;
    }
    console.warn("vyre: this browser cannot verify the release signature; running the shell unchecked");
  }
  if (v.checked && v.files && vc) {
    // What the fetch handler holds every later copy to, and the version no release may go under.
    await cache.put(HASHES_KEY, new Response(JSON.stringify(v.files), { headers: { "content-type": "application/json" } }));
    await vc.put("/version", new Response(v.version));
  }
  await self.skipWaiting();
})()));
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE && k !== OFFLINE_CACHE && k !== VERSION_CACHE) await caches.delete(k);
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

const CODE_PATH = /(^\/$|\.(m?js|css|html)$)/;
/** The signed release's hash for one shell path, from the list install stored, else null. @param {Cache} cache @param {string} path */
async function listed(cache, path) {
  try {
    const r = await cache.match(HASHES_KEY);
    return r ? new Map(await r.json()).get(path) || null : null;
  } catch { return null; }
}

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
  if (e.request.method !== "GET" || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/fixtures/")) return;
  // The onboarding and sign-in pages (the passkey claim among them) are never cached, and on an
  // unsigned build never touched. On a signed build they are fetched and held to the release's
  // hash list like every other served file: a page the release does not list, or whose bytes
  // differ, is refused. (The first visit to a box has no worker yet: that load is the box's own.)
  if (url.pathname.startsWith("/onboard") || url.pathname.startsWith("/person/")) {
    if (!SHELL_SIGNED) return;
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      if (!(await cache.match(HASHES_KEY))) return fetch(e.request); // no list stored: an unchecked shell
      const want = await listed(cache, url.pathname);
      if (!want) return Response.error();
      let res;
      try { res = await fetch(e.request); } catch { return Response.error(); }
      if (!res.ok) return res;
      return await sha(url.pathname, await res.clone().arrayBuffer()) === want ? res : Response.error();
    })());
    return;
  }
  // The Deck's own files: from the cache at once, and fetched behind it so the next launch has
  // whatever changed (stale-while-revalidate). A phone on the tailnet would otherwise wait a round
  // trip per module on every tab it opens. Every page address is the one shell, index.html.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = e.request.mode === "navigate" ? "/" : e.request;
    const hit = await cache.match(key);
    // A signed shell: a file is written to the cache only when its bytes are the ones the signed
    // release listed (install stored the list), so an origin cannot swap code in on a later
    // launch. A copy that does not match is never cached, and never served on a first visit.
    // "Signed" means this install stored the release's list; none stored (a browser that could not check) is an unsigned shell.
    const enforce = SHELL_SIGNED && !!(await cache.match(HASHES_KEY));
    const want = enforce ? await listed(cache, e.request.mode === "navigate" ? "/" : url.pathname) : null;
    // And a script, stylesheet or page the release did not list is refused outright, not fetched:
    // the vault, pairing and settings code are as much the release as the precached shell. Images
    // and fonts may stay unlisted; /theme.css is made per box.
    if (enforce && !want && (e.request.mode === "navigate" || CODE_PATH.test(url.pathname)) && url.pathname !== "/theme.css") return Response.error();
    const fresh = fetch(e.request).then(async res => {
      if (res.ok && res.type === "basic") {
        if (!enforce) cache.put(key, res.clone());
        else if (want && await sha(url.pathname, await res.clone().arrayBuffer()) === want) cache.put(key, res.clone());
        else if (want) return Response.error();
      }
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    try { return await fresh; } catch { return Response.error(); }
  })());
});
