// @ts-check
// The one app at /app/ (ADR 0027): its files from dist as a single-page app, its service worker
// made from dist/precache.json, and its manifest.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { tempHome } from "../../test/helpers.js";
import { socketPath } from "../config/index.js";
import { serveApp, appWorker, appManifest, appBase } from "./app.js";
import { start } from "./index.js";

/** A response that records what serveApp wrote. */
function fakeRes() {
  /** @type {any} */
  const r = { status: 0, headers: {}, body: "" };
  r.writeHead = (/** @type {number} */ s, /** @type {any} */ h = {}) => { r.status = s; for (const [k, v] of Object.entries(h)) r.headers[k.toLowerCase()] = v; };
  r.end = (/** @type {any} */ b) => { r.body = b === undefined ? "" : String(b); };
  return r;
}

/** A small export: index.html, one hashed bundle, an icon, and a precache list. */
function dist(/** @type {any} */ t, precache = { build: "b1", files: ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js"] }) {
  const home = tempHome(t);
  const dir = path.join(home, "dist");
  fs.mkdirSync(path.join(dir, "_expo", "static", "js", "web"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Vyre</title>");
  fs.writeFileSync(path.join(dir, "_expo", "static", "js", "web", "entry-abc.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "assets", "icon.png"), "png");
  fs.writeFileSync(path.join(home, "package.json"), "{\"secret\": true}");
  fs.writeFileSync(path.join(dir, "precache.json"), JSON.stringify(precache));
  return dir;
}

const get = (/** @type {string} */ p, /** @type {any} */ opts) => { const r = fakeRes(); serveApp(r, p, opts); return r; };

test("app: files from dist, the shell for any route, nothing outside dist", t => {
  const dir = dist(t);
  const js = get("/app/_expo/static/js/web/entry-abc.js", { dir });
  assert.equal(js.status, 200);
  assert.equal(js.body, "console.log(1)");
  assert.equal(js.headers["content-type"], "text/javascript");
  assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  assert.match(js.headers["content-security-policy"], /default-src 'self'/);

  const icon = get("/app/assets/icon.png", { dir });
  assert.deepEqual([icon.status, icon.headers["content-type"], icon.headers["cache-control"]], [200, "image/png", "no-cache"]);

  for (const p of ["/app/", "/app/needs/a_1", "/app/chat/s/42"]) {
    const r = get(p, { dir });
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<title>Vyre<\/title>/, p);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.headers["cache-control"], "no-cache", `${p}: the shell is never immutable`);
  }
  assert.equal(get("/app/_expo/static/js/web/entry-old.js", { dir }).status, 404, "a stale bundle is a 404, not the shell");

  for (const p of ["/app/../package.json", "/app/..%2fpackage.json", "/app/%2e%2e/%2e%2e/package.json"]) {
    const r = get(p, { dir });
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /secret/, p);
  }

  const redirect = get("/app", { dir });
  assert.deepEqual([redirect.status, redirect.headers.location], [301, "/app/"]);
});

test("app: no dist on this machine is no_app", t => {
  const r = get("/app/", { dir: path.join(tempHome(t), "nothing") });
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).error.code, "no_app");
});

test("app: with config app.root off, vyred serves the app at /app and nothing answers /", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], app: { root: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const hit = (/** @type {string} */ p) => new Promise((resolve, reject) => {
    http.get({ socketPath: socketPath(root), path: p }, res => {
      let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on("error", reject);
  });
  const a = /** @type {any} */ (await hit("/app"));
  assert.deepEqual([a.status, a.headers.location], [301, "/app/"]);
  const b = /** @type {any} */ (await hit("/app/now"));
  if (fs.existsSync(path.join(import.meta.dirname, "..", "..", "apps", "app", "dist"))) assert.equal(b.status, 200);
  else assert.equal(JSON.parse(b.body).error.code, "no_app");
  const other = /** @type {any} */ (await hit("/now"));
  assert.equal(other.status, 404, "there is no other web app to answer a page address");
});

test("app: with config app.root (the default), /app/* is a 301 to the same path under / instead of serving the app", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], app: { root: true } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const hit = (/** @type {string} */ p) => new Promise((resolve, reject) => {
    http.get({ socketPath: socketPath(root), path: p }, res => {
      let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on("error", reject);
  });
  const a = /** @type {any} */ (await hit("/app"));
  assert.deepEqual([a.status, a.headers.location], [301, "/"], "the bare path redirects to root");
  const b = /** @type {any} */ (await hit("/app/"));
  assert.deepEqual([b.status, b.headers.location], [301, "/"]);
  const c = /** @type {any} */ (await hit("/app/now?tab=chat"));
  assert.deepEqual([c.status, c.headers.location], [301, "/now?tab=chat"], "a deeper path and its query survive the redirect");
  const page = /** @type {any} */ (await hit("/now"));
  if (fs.existsSync(path.join(import.meta.dirname, "..", "..", "apps", "app", "dist"))) assert.notEqual(page.status, 301, "the app answers a page address at /");
  else assert.equal(JSON.parse(page.body).error.code, "no_app", "the app answers a page address at /, here it is not built");

  // The redirect must never become protocol-relative ("//host/path" is scheme-relative, so a
  // browser reading Location: //evil.example leaves the box entirely for it).
  const open1 = /** @type {any} */ (await hit("/app//evil.example/x"));
  assert.equal(open1.status, 301);
  assert.ok(!open1.headers.location.startsWith("//"), `open redirect: ${open1.headers.location}`);
  assert.equal(open1.headers.location, "/evil.example/x");
  const open2 = /** @type {any} */ (await hit("/app/\\evil.example"));
  assert.equal(open2.status, 301);
  assert.ok(!open2.headers.location.startsWith("//"), `open redirect via backslash: ${open2.headers.location}`);
  // Percent-encoded slashes stay encoded in the path (never decoded to a real "/" here), so this
  // one was never actually exploitable, but it is worth pinning down that no decoded form of it
  // produces a leading "//" either.
  const enc = /** @type {any} */ (await hit("/app/%2F%2Fevil.example"));
  assert.equal(enc.status, 301);
  assert.ok(!enc.headers.location.startsWith("//"), `open redirect via percent-encoding: ${enc.headers.location}`);
});

test("app: the worker's PRECACHE holds only /app/ paths and its BUILD comes from precache.json", t => {
  const dir = dist(t, { build: "abc 123!", files: ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js", "/v1/tools/x", "/now", 7, "/app/../package.json", "https://example.com/app/x"] });
  const src = appWorker({ dir });
  const pre = JSON.parse(/** @type {string[]} */ (/const PRECACHE = (\[.*\]);/.exec(src))[1]);
  assert.deepEqual(pre, ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js"]);
  assert.match(src, /const BUILD = "abc123";/);

  // No build in the list: this vyred's, as the Deck's worker has it. No list at all: just the shell.
  fs.writeFileSync(path.join(dir, "precache.json"), JSON.stringify({ files: Array.from({ length: 2500 }, (_, i) => `/app/f${i}.js`) }));
  const big = appWorker({ dir, build: { version: "0.0.1", commit: "1a2b3c4d5e6f7a8b", dirty: false } });
  assert.match(big, /const BUILD = "1a2b3c4d5e6f";/);
  assert.equal(JSON.parse(/** @type {string[]} */ (/const PRECACHE = (\[.*\]);/.exec(big))[1]).length, 2000);
  fs.rmSync(path.join(dir, "precache.json"));
  assert.match(appWorker({ dir, build: { version: "0.0.2", commit: null, dirty: null } }), /const PRECACHE = \["\/app\/index.html"\];\nconst BUILD = "v0.0.2";/);

  const r = get("/app/sw.js", { dir });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/javascript");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal(r.headers["service-worker-allowed"], "/app/");
});

/** Runs the generated worker in a fake service-worker global. */
function worker(/** @type {string} */ src) {
  /** @type {Record<string, Function>} */
  const on = {};
  const shown = [], closed = [], badges = [], fetched = [], deleted = [];
  /** @type {Map<string, Map<string, any>>} */
  const stores = new Map([["vyre-deck-7-x", new Map()], ["vyre-app-old", new Map()]]);
  const open = [{ tag: "planner-f_1", close: () => closed.push("ring") }];
  const caches = {
    open: async (/** @type {string} */ n) => {
      if (!stores.has(n)) stores.set(n, new Map());
      const m = /** @type {Map<string, any>} */ (stores.get(n));
      return { put: async (/** @type {any} */ k, /** @type {any} */ v) => { m.set(typeof k === "string" ? k : k.url, v); }, match: async (/** @type {any} */ k) => m.get(typeof k === "string" ? k : k.url) };
    },
    keys: async () => [...stores.keys()],
    delete: async (/** @type {string} */ n) => { deleted.push(n); return stores.delete(n); },
  };
  const self = { addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { on[type] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
    navigator: { setAppBadge: async (/** @type {any[]} */ ...a) => { badges.push(a); } },
    registration: { showNotification: async (/** @type {string} */ title, /** @type {any} */ o) => { shown.push({ title, ...o }); if (o.tag === "planner-f_1") open.push({ tag: o.tag, close: () => closed.push("ack") }); },
      getNotifications: async ({ tag }) => open.filter(n => n.tag === tag) } };
  const fetch = async (/** @type {string} */ p) => { fetched.push(p); if (p.includes("missing")) throw new Error("offline"); return { ok: true, type: "basic", clone() { return this; }, body: p }; };
  vm.runInNewContext(src, { self, URL, Response, caches, fetch, console, location: { origin: "https://box.example" } });
  const fire = async (/** @type {string} */ type, /** @type {any} */ ev = {}) => {
    const waits = [];
    let answered = null;
    on[type]({ ...ev, waitUntil: (/** @type {any} */ p) => waits.push(p), respondWith: (/** @type {any} */ p) => { answered = p; } });
    await Promise.all(waits);
    return answered;
  };
  return { on, fire, shown, closed, badges, fetched, deleted, stores };
}

test("app worker: install keeps the list (one failure does not stop it), activate clears only old app caches", async t => {
  const dir = dist(t, { build: "b7", files: ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js", "/app/missing.png"] });
  const w = worker(appWorker({ dir }));
  await w.fire("install");
  assert.deepEqual(w.fetched, ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js", "/app/missing.png"]);
  assert.deepEqual([...(w.stores.get("vyre-app-b7") || new Map()).keys()], ["/app/index.html", "/app/_expo/static/js/web/entry-abc.js"]);
  await w.fire("activate");
  assert.deepEqual(w.deleted, ["vyre-app-old"], "the Deck's cache is the Deck's");

  // Fetch: /v1/ and the Deck's paths are never answered; a navigation gets the cached shell.
  const req = (/** @type {string} */ u, mode = "cors", method = "GET") => ({ request: { url: "https://box.example" + u, method, mode } });
  assert.equal(await w.fire("fetch", req("/v1/tools/threads.get", "cors", "POST")), null);
  assert.equal(await w.fire("fetch", req("/v1/events")), null);
  assert.equal(await w.fire("fetch", req("/now", "navigate")), null);
  assert.equal(await w.fire("fetch", req("/app/x", "navigate", "POST")), null);
  const nav = await /** @type {any} */ (await w.fire("fetch", req("/app/needs/a_1", "navigate")));
  assert.equal(nav.body, "/app/index.html");
});

test("app worker: a push opens under /app/, a planner-ack shows then closes, ask and draft set a dot", async t => {
  const w = worker(appWorker({ dir: dist(t) }));
  const push = (/** @type {any} */ d) => w.fire("push", { data: { json: () => d } });
  await push({ kind: "ask", title: "A session is waiting for your answer", path: "/needs/x", tag: "ask-x", at: 1 });
  assert.deepEqual([w.shown[0].body, w.shown[0].tag, w.shown[0].data.path], ["Waiting on your answer.", "ask-x", "/app/needs/x"]);
  await push({ kind: "draft", title: "Held at the Gate", path: "/app/needs/g", tag: "draft-g", at: 1 });
  assert.equal(w.shown[1].data.path, "/app/needs/g", "an /app/ path is kept as it is");
  assert.deepEqual(w.badges, [[], []]);
  await push({ kind: "planner", title: "Reminder", path: "/planner/f_2", tag: "planner-f_2", body: "Call kit", at: 1 });
  assert.deepEqual([w.shown[2].body, w.shown[2].data.path], ["Call kit", "/app/planner/f_2"]);
  await push({ kind: "planner-ack", tag: "planner-f_1", at: 2 });
  assert.deepEqual([w.shown[3].body, w.shown[3].tag, w.shown[3].silent, w.shown[3].data.path], ["Answered.", "planner-f_1", true, "/app/now"]);
  assert.deepEqual(w.closed.sort(), ["ack", "ring"]);
  assert.equal(w.badges.length, 2, "only an ask and a draft set a dot");
});

test("app: the manifest is scoped to /app/, or is the export's own", t => {
  const dir = dist(t);
  const man = JSON.parse(get("/app/manifest.webmanifest", { dir }).body);
  assert.deepEqual([man.id, man.scope, man.start_url, man.display], ["/app/", "/app/", "/app/", "standalone"]);
  assert.equal(man.theme_color, "#0E0D0C");
  assert.ok(man.icons.length >= 2 && man.icons.every((/** @type {any} */ i) => i.src.startsWith("/icon")));
  assert.equal(get("/app/manifest.webmanifest", { dir }).headers["content-type"], "application/manifest+json");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), JSON.stringify({ name: "Own", scope: "/app/" }));
  assert.equal(JSON.parse(appManifest({ dir })).name, "Own");
});

test("the verified-link files: absent until the signing identities are set, then exactly the app's package and paths", async () => {
  const { associationFile } = await import("./app.js");
  assert.equal(associationFile("/.well-known/apple-app-site-association", {}), null);
  assert.equal(associationFile("/.well-known/assetlinks.json", {}), null);
  assert.equal(associationFile("/.well-known/other", { VYRE_APPLE_TEAM_ID: "ABCDE12345" }), null);
  const a = JSON.parse(/** @type {string} */ (associationFile("/.well-known/apple-app-site-association", { VYRE_APPLE_TEAM_ID: "ABCDE12345" })));
  assert.deepEqual(a.applinks.details[0].appIDs, ["ABCDE12345.sh.vyre.app"]);
  assert.deepEqual(a.applinks.details[0].components, [{ "/": "/app/join*" }, { "/": "/app/pair*" }]);
  assert.equal(associationFile("/.well-known/apple-app-site-association", { VYRE_APPLE_TEAM_ID: "bad" }), null);
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(":").toUpperCase();
  const l = JSON.parse(/** @type {string} */ (associationFile("/.well-known/assetlinks.json", { VYRE_ANDROID_CERT_SHA256: fp })));
  assert.equal(l[0].target.package_name, "sh.vyre.app"); assert.deepEqual(l[0].target.sha256_cert_fingerprints, [fp]);
  assert.equal(associationFile("/.well-known/assetlinks.json", { VYRE_ANDROID_CERT_SHA256: "12:34" }), null);
});

test("app at the root (config app.root, an export built with the root base): files, the shell for any route, a worker rooted at /", t => {
  const dir = dist(t, { build: "r1", base: "", files: ["/index.html", "/_expo/static/js/web/entry-abc.js"] });
  assert.equal(appBase(dir), "", "precache.json names the root");
  const js = get("/_expo/static/js/web/entry-abc.js", { dir });
  assert.deepEqual([js.status, js.headers["cache-control"]], [200, "public, max-age=31536000, immutable"]);
  for (const p of ["/", "/u/now", "/session/42"]) {
    const r = get(p, { dir });
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<title>Vyre<\/title>/, p);
  }
  assert.equal(get("/_expo/static/js/web/entry-gone.js", { dir }).status, 404, "a stale hashed file is a 404, not the shell");
  assert.equal(get("/../package.json", { dir }).status, 404, "a path above dist is refused");
  assert.ok(!get("/../package.json", { dir }).body.includes("secret"));
  const sw = get("/sw.js", { dir });
  assert.equal(sw.headers["service-worker-allowed"], "/");
  assert.match(sw.body, /const BASE = "";/);
  assert.match(sw.body, /const PRECACHE = \["\/index\.html","\/_expo\/static\/js\/web\/entry-abc\.js"\];/);
  const mf = JSON.parse(get("/manifest.webmanifest", { dir }).body);
  assert.deepEqual([mf.start_url, mf.scope, mf.id], ["/", "/", "/"]);
});

test("app worker at the root: only the app's pages, never the box's own paths or /v1/", t => {
  const dir = dist(t, { build: "r2", base: "", files: ["/index.html"] });
  const src = appWorker({ dir });
  /** @type {Record<string, Function>} */ const on = {};
  const hits = [];
  const self = { addEventListener: (/** @type {string} */ n, /** @type {Function} */ f) => { on[n] = f; }, registration: {}, clients: {} };
  const ctx = vm.createContext({ self, caches: { open: async () => ({ match: async () => null, put: async () => {} }) }, fetch: async () => { throw new Error("offline"); }, Response: { error: () => 0 }, URL, location: { origin: "https://box.example" } });
  vm.runInContext(src, ctx);
  const handled = (/** @type {string} */ p, mode = "navigate") => { let r = false; on.fetch({ request: { url: "https://box.example" + p, method: "GET", mode }, respondWith: (/** @type {Promise<unknown>} */ p) => { r = true; p.catch(() => {}); }, waitUntil() {} }); return r; };
  assert.equal(handled("/"), true);
  assert.equal(handled("/u/now"), true);
  for (const p of ["/v1/events", "/onboard/passkey", "/person/signin", "/release/SHA256SUMS", "/.well-known/assetlinks.json", "/sw.js"]) assert.equal(handled(p), false, p);
  void hits;
});

test("app at /app/ is unchanged by the root support: a worker with BASE /app", t => {
  const dir = dist(t);
  assert.equal(appBase(dir), "/app", "no base in precache.json means /app");
  assert.match(appWorker({ dir }), /const BASE = "\/app";/);
});
