// web.vyre.run: the release's signed web export laid out by scripts/build-web-out.mjs, and the Worker that serves it. A throwaway key signs a small export
// that has the page's shape (an inline splash script and style, one entry script), the way the release signs the real one.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildAppOut } from "../../scripts/build-app-out.mjs";
import { buildWebOut, cspHash, inlineHashes } from "../../scripts/build-web-out.mjs";
import worker, { cspFor, SECURITY } from "./worker.js";

const SPLASH = 'var t0=Date.now();window.__vyreSplashDone=function(){};';
const STYLE = "html,body{margin:0}";
const HTML = `<!doctype html><html><head><style id="vyre-shell">${STYLE}</style></head><body><div id="root"></div><script>${SPLASH}</script><script src="/app/_expo/static/js/web/entry.js" defer></script></body></html>`;

async function sealed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-web-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "_expo/static/js/web"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), HTML);
  fs.writeFileSync(path.join(dist, "_expo/static/js/web/entry.js"), "document.title='ok'");
  fs.writeFileSync(path.join(dist, "splash.html"), "<p>splash</p>");
  const r = await buildAppOut({ dist, release: "1.2.3", out: path.join(tmp, "app-out"), throwaway: true, base: "/app" });
  return { tmp, appOut: path.join(tmp, "app-out"), pub: new Uint8Array(Buffer.from(r.pub, "base64url")), line: r.line };
}

/** An ASSETS binding over a folder: a file is a 200, anything else a 404. */
const assetsOf = dir => ({ fetch: async req => {
  const f = path.join(dir, decodeURIComponent(new URL(req.url).pathname));
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response("nf", { status: 404 });
  return new Response(fs.readFileSync(f), { headers: { "content-type": f.endsWith(".json") ? "application/json" : "text/plain" } });
} });
const get = (env, p, init) => worker.fetch(new Request(`https://web.vyre.run${p}`, init), env);

test("the release's own signed build is laid out, and vyre-build.json names it", async () => {
  const s = await sealed(); const out = path.join(s.tmp, "web-out");
  const r = await buildWebOut({ appOut: s.appOut, out, pub: s.pub });
  const info = JSON.parse(fs.readFileSync(path.join(out, "vyre-build.json"), "utf8"));
  assert.equal(info.release, "1.2.3");
  assert.equal(info.folder, s.line.sha);
  assert.equal(info.manifest.slice(0, 40), info.folder);
  assert.equal(info.index, crypto.createHash("sha256").update(HTML).digest("hex"));
  assert.deepEqual(info.scriptHashes, [cspHash(SPLASH)]);
  assert.deepEqual(info.styleHashes, [cspHash(STYLE)]);
  assert.equal(fs.readFileSync(path.join(out, "app/index.html"), "utf8"), HTML, "the page is the signed bytes, not a rewrite");
  assert.ok(fs.existsSync(path.join(out, "app/release-manifest.json")) && fs.existsSync(path.join(out, "app/release-manifest.sig")));
  assert.equal(r.release, "1.2.3");
});

test("a build signed by another key, or a file changed after signing, is refused", async () => {
  const s = await sealed();
  await assert.rejects(buildWebOut({ appOut: s.appOut, out: path.join(s.tmp, "w1"), pub: new Uint8Array(crypto.randomBytes(32)) }));
  fs.appendFileSync(path.join(s.appOut, "v", s.line.sha, "_expo/static/js/web/entry.js"), ";evil()");
  await assert.rejects(buildWebOut({ appOut: s.appOut, out: path.join(s.tmp, "w2"), pub: s.pub }), /does not match the manifest/);
});

test("the policy: scripts only from the app and the page's own inline hashes, styles may be inline, nothing is reachable from a style", () => {
  const csp = cspFor({ scriptHashes: ["sha256-AAA="], styleHashes: ["sha256-BBB="] });
  const dir = (n) => csp.split("; ").find(d => d.startsWith(n)) || "";
  assert.equal(dir("script-src"), "script-src 'self' 'sha256-AAA='");
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.equal(dir("style-src"), "style-src 'self' 'unsafe-inline'", "no style hash is listed: one would switch unsafe-inline off");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("the policy never widens beyond the app, the relay, the names directory and a space's own address: images, fonts, connections, frames, forms, base", () => {
  const csp = cspFor({ scriptHashes: [], styleHashes: [] });
  const dir = (n) => (csp.split("; ").find(d => d.startsWith(n + " ")) || "").split(" ").slice(1).sort();
  assert.deepEqual(dir("default-src"), ["'none'"]);
  assert.deepEqual(dir("img-src"), ["'self'", "blob:", "data:"].sort());
  assert.deepEqual(dir("font-src"), ["'self'"]);
  assert.deepEqual(dir("connect-src"), ["'self'", "https://relay.vyre.run", "wss://relay.vyre.run", "https://names.vyre.run", "https://*.vyre.run"].sort());
  assert.deepEqual(dir("frame-ancestors"), ["'none'"]);
  assert.deepEqual(dir("base-uri"), ["'none'"]);
  assert.deepEqual(dir("form-action"), ["'none'"]);
  assert.doesNotMatch(csp, /\bhttp:|\bws:|\*[^.]|ts\.net| \* /, "no plain http or ws, no bare wildcard, no tailnet");
});

test("inline hashes cover inline scripts and styles only", () => {
  const h = inlineHashes('<style>a{}</style><script>1</script><script src="/x.js"></script><script src="/y.js"> </script>');
  assert.deepEqual(h, { scriptHashes: [cspHash("1")], styleHashes: [cspHash("a{}")] });
});

test("the worker: strict policy from the build's hashes, the app under /app, the page for a route, a 404 for a missing file", async () => {
  const s = await sealed(); const out = path.join(s.tmp, "web-out");
  await buildWebOut({ appOut: s.appOut, out, pub: s.pub });
  const env = { ASSETS: assetsOf(out) };
  const home = await get(env, "/");
  assert.equal(home.status, 200);
  assert.equal(await home.text(), HTML);
  const csp = home.headers.get("content-security-policy");
  assert.equal(csp, cspFor(JSON.parse(fs.readFileSync(path.join(out, "vyre-build.json"), "utf8"))));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src 'self' '${cspHash(SPLASH).replace(/[+/]/g, "\\$&")}'`));
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|https:\/\/(?!relay|names|\*\.vyre\.run)[^ ;]*\.(com|net|io|org)/, "scripts stay strict; only styles may be inline");
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  for (const [k, v] of Object.entries(SECURITY)) assert.equal(home.headers.get(k), v, k);
  assert.match(home.headers.get("strict-transport-security"), /max-age=63072000.*preload/);
  assert.equal(home.headers.get("set-cookie"), null);
  assert.equal((await get(env, "/onboard")).status, 200, "a route of the app gets the page");
  assert.equal(await (await get(env, "/u/install#frag")).text(), HTML);
  const js = await get(env, "/app/_expo/static/js/web/entry.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control"), /immutable/);
  assert.equal((await get(env, "/app/_expo/static/js/web/missing.js")).status, 404, "a missing script is a 404, never the page");
  assert.equal((await get(env, "/", { method: "POST" })).status, 405);
  const b = await get(env, "/vyre-build.json");
  assert.equal(b.headers.get("cache-control"), "no-cache");
});

test("with no release laid out the worker says so and serves no page", async () => {
  const env = { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
  const r = await get(env, "/");
  assert.equal(r.status, 503);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
});

test("wrangler.toml: workers.dev off and exactly the web.vyre.run custom domain, as top-level keys", () => {
  const text = fs.readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8").split("\n");
  const end = text.findIndex(l => /^\s*\[/.test(l));
  const top = (end < 0 ? text : text.slice(0, end)).filter(l => !/^\s*#/.test(l)).join("\n");
  assert.match(top, /^workers_dev\s*=\s*false\s*$/m);
  const routes = [...top.matchAll(/^routes\s*=\s*\[(.*)\]\s*$/gm)];
  assert.equal(routes.length, 1);
  assert.deepEqual([...routes[0][1].matchAll(/pattern\s*=\s*"([^"]+)"/g)].map(m => m[1]), ["web.vyre.run"]);
  assert.match(routes[0][1], /custom_domain\s*=\s*true/);
});
