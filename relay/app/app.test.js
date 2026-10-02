// @ts-check
// relay/app: the signed manifest, release.js, the app.vyre.run Worker's headers, the pair page's
// parser and the service worker (in a vm with fake caches and fetch). No network, no browser.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { buildManifest, verifyManifest, signManifest, canonical, newer, folderOf, sha256Hex, MANIFEST, SIGNATURE } from "./manifest.js";
import { keygen, build, loader, verify, loadKey, entriesOf } from "./release.js";
import worker, { CSP } from "./worker.js";
import { parseOffer } from "./pair/pair.js";
import { pairUrl } from "../../core/relay/pairing.js";

const scratch = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const pubOf = key => new Uint8Array(Buffer.from(fs.readFileSync(`${key}.pub`, "utf8").trim(), "base64url"));

/** A tiny stand-in for an Expo web export. */
function fakeDist(dir, release = "0.4.2") {
  fs.mkdirSync(path.join(dir, "_expo/static/js/web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/_expo/static/js/web/entry-${release}.js" defer></script>`);
  fs.writeFileSync(path.join(dir, `_expo/static/js/web/entry-${release}.js`), `console.log("Harlow Legal ${release}")`);
  fs.writeFileSync(path.join(dir, "app.css"), "body{margin:0}");
  return dir;
}

test("manifest: canonical bytes, a valid signature, and every kind of tamper refused", async t => {
  const key = path.join(scratch(t), "release.key");
  keygen(key);
  const files = { "a.js": new TextEncoder().encode("a"), "b.css": new TextEncoder().encode("b") };
  const bytes = await buildManifest({ release: "1.2.3", created: 1, entry: ["a.js"], files });
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  const sig = await signManifest(bytes, await loadKey(key));
  const ok = await verifyManifest(bytes, sig, pubOf(key));
  assert.equal(ok.manifest.release, "1.2.3");
  assert.equal(ok.sha256, await sha256Hex(bytes));
  const bent = Uint8Array.from(bytes);
  bent[bent.length - 3] ^= 1;
  await assert.rejects(verifyManifest(bent, sig, pubOf(key)), /does not verify/);
  const other = path.join(scratch(t), "other.key");
  keygen(other);
  await assert.rejects(verifyManifest(bytes, sig, pubOf(other)), /does not verify/);
  await assert.rejects(buildManifest({ release: "1.2", files }), /not a release manifest/);
  await assert.rejects(buildManifest({ release: "1.2.3", files: { "../x": files["a.js"] } }), /bad manifest entry/);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.4.2", "0.4.2"), false);
});

test("release: build seals the app into /v/<sha>/, verify catches a changed file", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  const dist = fakeDist(path.join(dir, "dist"));
  const out = path.join(dir, "out");
  const r = await build({ dist, release: "0.4.2", key, out });
  assert.equal(r.sha, folderOf(r.manifest));
  const folder = path.join(out, "v", r.sha);
  assert.equal(await verify(folder, pubOf(key)), r.manifest, "the hash the box lists is the manifest's sha256");
  const m = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), "utf8"));
  assert.deepEqual(m.entry, ["app.css", "_expo/static/js/web/entry-0.4.2.js"]);
  assert.match(m.files["app.css"], /^sha384-/);
  fs.appendFileSync(path.join(folder, "app.css"), "/* Northwind Bakery was here */");
  await assert.rejects(verify(folder, pubOf(key)), /app.css does not match/);
  assert.deepEqual(entriesOf('<script src="/x.js"></script><link href="https://cdn.example/y.css">', { "x.js": 1 }), ["x.js"]);
});

test("release: the loader is sealed, pinned by SRI in its page, and sw.js carries the public key", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  const pub = keygen(key);
  const out = path.join(dir, "out");
  const r = await loader({ release: "1.0.0", key, out });
  assert.equal(await verify(out, pubOf(key)), r.manifest);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /src="\/loader.js" integrity="sha384-/);
  assert.match(html, /<div id="root">/);
  assert.doesNotMatch(html, /<script>|<style>|style="/, "no inline script or style: the CSP allows none");
  assert.ok(fs.readFileSync(path.join(out, "sw.js"), "utf8").includes(`"${pub}"`));
  assert.ok(fs.readFileSync(path.join(out, "loader.js"), "utf8").includes(`"${pub}"`));
  assert.ok(fs.existsSync(path.join(out, "client/client.js")));
  // "Add to Home Screen" installs the app, not a bookmark, only with a web app manifest, its icons and the iOS tags.
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
  const wm = JSON.parse(fs.readFileSync(path.join(out, "manifest.webmanifest"), "utf8"));
  assert.deepEqual([wm.display, wm.start_url, wm.scope], ["standalone", "/", "/"]);
  for (const i of wm.icons) assert.ok(fs.existsSync(path.join(out, i.src.slice(1))), `${i.src} is served`);
  assert.ok(fs.existsSync(path.join(out, "apple-touch-icon.png")));
  const signedList = JSON.parse(fs.readFileSync(path.join(out, "release-manifest.json"), "utf8")).files;
  for (const f of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) assert.ok(f in signedList, `${f} is in the signed loader`);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(out, "icon-192.png")), fs.readFileSync(path.join(import.meta.dirname, "..", "..", "deck", "icon-192.png"))), 0, "icons are copied as bytes, not text");
  assert.match(fs.readFileSync(path.join(out, "manifest.js"), "utf8"), /"\.\/client\/bytes\.js"/);
});

// ---- the Worker ----

const assets = files => ({
  async fetch(req) {
    const p = new URL(req.url).pathname;
    return p in files ? new Response(files[p], { headers: { "content-type": "text/plain", "set-cookie": "x=1" } }) : new Response("nope", { status: 404 });
  },
});

test("worker: strict headers everywhere, immutable folders, the loader for any app route", async () => {
  const sha = "a".repeat(40);
  const env = { ASSETS: assets({ "/index.html": "loader page", "/sw.js": "sw", [`/v/${sha}/app.js`]: "app" }) };
  const get = (p, init) => worker.fetch(new Request(`https://app.vyre.run${p}`, init), env);

  const page = await get("/pair");
  assert.equal(await page.text(), "loader page", "a route the app owns gets the loader, fragment intact in the browser");
  assert.equal(page.headers.get("content-security-policy"), CSP);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe/);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(String(page.headers.get("permissions-policy")), /camera=\(self\)/);

  const app = await get(`/v/${sha}/app.js`);
  assert.equal(await app.text(), "app");
  assert.match(String(app.headers.get("cache-control")), /immutable/);
  assert.equal((await get("/v/nothex/app.js")).status, 404);
  assert.equal((await get("/app/assets/font.ttf")).status, 404, "the built app's files are never the loader page");
  assert.equal((await get("/sw.js")).headers.get("cache-control"), "no-cache");
  assert.equal((await get("/", { method: "POST" })).status, 405);
});

// ---- the pair page ----

test("pair page: reads a real offer, refuses junk", () => {
  const url = pairUrl({ relay: "wss://relay.vyre.run", route: "abcdefghijklmnopqrstuvwxyz", box: Buffer.alloc(32, 7), secret: "s3cr3t", name: "alex" });
  const offer = parseOffer(url.slice(url.indexOf("#") + 1));
  assert.deepEqual(offer, { relay: "wss://relay.vyre.run", route: "abcdefghijklmnopqrstuvwxyz", name: "alex" });
  assert.equal(parseOffer("not-base64-json"), null);
  assert.equal(parseOffer(Buffer.from(JSON.stringify({ v: 1, r: "https://evil.example", i: "abcdefghijklmnopqrstuvwxyz", s: "x", k: "A".repeat(43) })).toString("base64url")), null);
});

// ---- the service worker, in a vm ----

/** A browser-ish world for sw.js: caches, fetch over a directory, clients, and its handlers. */
function swWorld(dir) {
  /** @type {Map<string, Map<string, Response>>} */
  const store = new Map();
  const cacheOf = name => {
    if (!store.has(name)) store.set(name, new Map());
    const m = /** @type {Map<string, Response>} */ (store.get(name));
    const key = r => (typeof r === "string" ? r : new URL(r.url).pathname);
    return {
      match: async r => { const x = m.get(key(r)); return x ? x.clone() : undefined; },
      put: async (r, res) => { m.set(key(r), res.clone()); },
      delete: async r => m.delete(key(r)),
    };
  };
  const caches = { open: async n => cacheOf(n), keys: async () => [...store.keys()], delete: async n => store.delete(n) };
  const fetched = [];
  const fetch = async req => {
    const p = typeof req === "string" ? req : new URL(req.url).pathname;
    fetched.push(p);
    const f = path.join(dir(), p);
    return fs.existsSync(f) && fs.statSync(f).isFile() ? new Response(fs.readFileSync(f)) : new Response("missing", { status: 404 });
  };
  const handlers = {};
  const messages = [];
  const self = { location: { origin: "https://app.vyre.run" }, addEventListener: (t, fn) => { handlers[t] = fn; } };
  const clients = { matchAll: async () => [{ postMessage: m => messages.push(m) }], claim: async () => {} };
  const ctx = vm.createContext({ self, caches, clients, fetch, crypto: globalThis.crypto, Response, Request, URL, TextDecoder, atob, btoa, Uint8Array, Object, JSON, Array, String, Promise, Error });
  vm.runInContext(fs.readFileSync(path.join(dir(), "sw.js"), "utf8"), ctx);
  const fire = async (type, extra = {}) => {
    let p = Promise.resolve();
    const e = { ...extra, waitUntil: x => { p = x; }, respondWith: x => { p = x; } };
    handlers[type](e);
    return p;
  };
  return { fire, messages, fetched, store };
}

test("service worker: installs a signed loader, serves it, and refuses tampering and rollback", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  let out = path.join(dir, "v1");
  const r1 = await loader({ release: "1.1.0", key, out });
  const w = swWorld(() => out);
  await w.fire("install");
  await w.fire("activate");

  const page = await w.fire("fetch", { request: new Request("https://app.vyre.run/pair", { mode: "same-origin" }) });
  assert.match(await page.text(), /id="vyre-status"/, "the pair route is served from the pinned loader");
  const replies = [];
  await w.fire("message", { data: { type: "vyre-release?" }, source: { postMessage: m => replies.push(m) } });
  assert.deepEqual({ ...replies[0] }, { type: "vyre-release", release: "1.1.0", manifest: r1.manifest }, "the reply comes from the worker's realm, so compare its fields");

  // A loader file changed at the CDN: the new worker refuses to install and says why.
  out = path.join(dir, "v2");
  await loader({ release: "1.2.0", key, out });
  fs.appendFileSync(path.join(out, "loader.css"), "body{display:none}");
  await assert.rejects(w.fire("install"), /loader.css does not match/);
  assert.equal(w.messages.at(-1).refused, true);

  // An older release, however well signed, never replaces a newer one.
  out = path.join(dir, "v0");
  await loader({ release: "1.0.9", key, out });
  await assert.rejects(w.fire("install"), /refusing loader 1.0.9/);

  // A loader signed with another key is refused.
  const other = path.join(dir, "other.key");
  keygen(other);
  out = path.join(dir, "v3");
  await loader({ release: "1.3.0", key: other, out });
  fs.copyFileSync(path.join(dir, "v1", "sw.js"), path.join(out, "sw.js"));
  await assert.rejects(w.fire("install"), /signature does not verify/);

  // A newer signed release is adopted, and the old cache goes.
  out = path.join(dir, "v4");
  const r4 = await loader({ release: "1.4.0", key, out });
  await w.fire("install");
  await w.fire("activate");
  const again = [];
  await w.fire("message", { data: { type: "vyre-release?" }, source: { postMessage: m => again.push(m) } });
  assert.equal(again[0].manifest, r4.manifest);
  assert.deepEqual([...w.store.keys()].filter(k => k.startsWith("vyre-loader-")), ["vyre-loader-1.4.0"]);
});

test("service worker: content-addressed folders are cached as fetched", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  const out = path.join(dir, "out");
  await loader({ release: "1.0.0", key, out });
  const { sha } = await build({ dist: fakeDist(path.join(dir, "dist")), release: "0.4.2", key, out });
  const w = swWorld(() => out);
  await w.fire("install");
  await w.fire("activate");
  const url = `https://app.vyre.run/v/${sha}/${SIGNATURE}`;
  await (await w.fire("fetch", { request: new Request(url) })).text();
  const n = w.fetched.length;
  assert.match(await (await w.fire("fetch", { request: new Request(url) })).text(), /^[A-Za-z0-9_-]{86}\n$/);
  assert.equal(w.fetched.length, n, "the second read came from the cache");
});

test("service worker: /app/<path> is answered from the build the loader named, hash-checked", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  const out = path.join(dir, "out");
  await loader({ release: "1.0.0", key, out });
  const { sha, manifest } = await build({ dist: fakeDist(path.join(dir, "dist")), release: "0.4.2", key, out });
  const w = swWorld(() => out);
  await w.fire("install");
  await w.fire("activate");
  const ask = p => w.fire("fetch", { request: new Request(`https://app.vyre.run/app/${p}`) });

  assert.equal((await ask("app.css")).status, 404, "nothing is served before a build is adopted");
  await w.fire("message", { data: { type: "vyre-build", sha, manifest } });
  assert.deepEqual({ ...w.messages.at(-1) }, { type: "vyre-build", ok: true, sha }, "the loader is told the build is adopted, so it can start the app");
  assert.equal((await w.fire("fetch", { request: new Request("https://app.vyre.run/app/%E0%A4%A") })).status, 404, "a malformed escape is a 404, not a thrown error");
  const ok = await ask("app.css");
  assert.equal(await ok.text(), "body{margin:0}");
  assert.equal((await ask("_expo/static/js/web/entry-0.4.2.js")).status, 200, "expo's own path under /app/");
  assert.equal((await ask("nope.png")).status, 404, "a file the manifest does not list");

  // A page that names a manifest the worker cannot verify adopts nothing new.
  const before = w.messages.length;
  await w.fire("message", { data: { type: "vyre-build", sha, manifest: "b".repeat(64) } });
  assert.equal(w.messages.length, before + 1);
  assert.equal(w.messages.at(-1).refused, true);

  // A file changed at the CDN after adoption is refused, not served.
  fs.appendFileSync(path.join(out, "v", sha, "app.css"), "x");
  const w2 = swWorld(() => out);
  await w2.fire("install"); await w2.fire("activate");
  await w2.fire("message", { data: { type: "vyre-build", sha, manifest } });
  assert.equal((await w2.fire("fetch", { request: new Request("https://app.vyre.run/app/app.css") })).status, 404);
});

import { pairTicketFrom, HOSTED_RELAY } from "./loader/fragment.js";
import nodeCrypto from "node:crypto";

test("loader: the camera page's #pair=<ticket> hand-off is read exactly, and nothing else is taken for one", () => {
  const ticket = nodeCrypto.randomBytes(8);
  const got = pairTicketFrom(`#pair=${ticket.toString("base64url")}`);
  assert.ok(got);
  assert.deepEqual(Buffer.from(/** @type {Uint8Array} */ (got)), ticket);
  assert.equal(HOSTED_RELAY, "wss://relay.vyre.run");
  assert.equal(pairTicketFrom("#pair=short"), null, "too short");
  assert.equal(pairTicketFrom(`#pair=${nodeCrypto.randomBytes(40).toString("base64url")}`), null, "too long");
  assert.equal(pairTicketFrom(`#pair=${ticket.toString("base64url")}&x=1`), null, "extra fields are not a hand-off");
  assert.equal(pairTicketFrom(`#enroll=${ticket.toString("base64url")}`), null);
  assert.equal(pairTicketFrom(""), null);
  assert.equal(pairTicketFrom("#pair=!!!!!!!!!!!!"), null);
});

// ---- the installed app pairs inside itself (loader/pairing.js and the scanner it ships) ----

test("release: the sealed loader ships the scanner and the in-app pairing, and every import in that tree resolves", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  const out = path.join(dir, "out");
  await loader({ release: "1.0.0", key, out });
  const m = JSON.parse(fs.readFileSync(path.join(out, "release-manifest.json"), "utf8"));
  for (const f of ["pairing.js", "fragment.js", "relay/wink/page.js", "relay/wink/flow.js", "relay/wink/wink.css", "deck/js/scan.js", "deck/js/scan-worker.js", "deck/js/haptics.js", "deck/js/pair-ticket.js"]) assert.ok(m.files[f], `${f} is sealed in the loader`);
  assert.ok(!m.files["deck/js/api.js"] && !m.files["deck/js/app.js"], "no Deck API client or shell in the app loader");
  const { specifiers } = await import("../wink/closure.js");
  for (const f of Object.keys(m.files).filter(f => /\.js$/.test(f))) {
    const dirOf = path.posix.dirname(f);
    for (const s of specifiers(fs.readFileSync(path.join(out, f), "utf8"))) {
      const next = path.posix.normalize(path.posix.join(dirOf, s));
      assert.ok(m.files[next], `${f} imports ${s}, which is not in the sealed loader`);
    }
  }
  assert.doesNotMatch(fs.readFileSync(path.join(out, "pairing.js"), "utf8"), /"\.\.\/\.\.\//, "the repo-relative scanner paths were rewritten");
});

test("pairing.js, from the sealed tree: a handed ticket is looked up again and shown on this origin's own card, and redeemed only on the tap", async t => {
  const dir = scratch(t);
  const key = path.join(dir, "release.key");
  keygen(key);
  const out = path.join(dir, "out");
  await loader({ release: "1.0.0", key, out });
  const { install } = await import("../../deck/test/fake-dom.js");
  install();
  /** @type {any} */ (globalThis).matchMedia = () => ({ matches: true });
  /** @type {any} */ (document).visibilityState = "visible";
  /** @type {any} */ (document).getElementById = () => null;
  /** @type {string[]} */ const log = [];
  const TICKET = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const timers = /** @type {(() => void)[]} */ ([]);
  const realSet = globalThis.setTimeout;
  /** @type {any} */ (globalThis).setTimeout = (/** @type {() => void} */ fn, /** @type {number} */ ms) => (ms === 650 || ms === 450 ? (timers.push(fn), 0) : realSet(fn, ms));
  t.after(() => { globalThis.setTimeout = realSet; });
  const { pairInApp } = await import(pathToFileURL(path.join(out, "pairing.js")).href);
  const tick = () => new Promise(r => realSet(r, 0));
  const done = pairInApp({ ticket: TICKET, relay: "wss://relay.test", name: "Alex's iPhone", about: {}, keyStore: {}, crypto: {}, nav: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    client: { resolveTicket: async () => { log.push("resolve"); return { name: "Alex's Mac", fingerprint: "AB12 CD34", handle: "alex" }; }, pairTicket: async (/** @type {Uint8Array} */ tk) => { log.push("pair " + [...tk].join(",")); return { name: "Alex's Mac", box: "k" }; } } });
  for (let i = 0; i < 8; i++) { await tick(); while (timers.length) timers.shift()?.(); }
  assert.deepEqual(log, ["resolve"], "looked up again here, and nothing redeemed before the tap");
  const body = /** @type {any} */ (document.body);
  const main = /** @type {any} */ ([...body.querySelectorAll("button")].find((/** @type {any} */ b) => b.className.includes("main")));
  assert.ok(main, "this origin shows its own card");
  main.dispatchEvent(Object.assign(new Event("click"), { button: 0 }));
  for (let i = 0; i < 8; i++) { await tick(); while (timers.length) timers.shift()?.(); }
  const box = await done;
  assert.deepEqual(log, ["resolve", "pair 1,2,3,4,5,6,7,8"]);
  assert.deepEqual(box, { name: "Alex's Mac", box: "k" });
  assert.equal(body.querySelectorAll("#vyre-wink").length, 0, "the screen is gone when pairing is done");
});
