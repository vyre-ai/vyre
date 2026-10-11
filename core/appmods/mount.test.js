// @ts-check
// The signing app's pages under /sign/_/ of the Space's own address (mount.js), and the front serving them (proxy.js): the text the app sends is put under the mount, a request under it is taken out of it,
// the pretty link goes to the page, an owner's cookie is not honoured there, and nothing else of the address is the app's. The live walk in a real browser is outside-signer.live.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MOUNT, toApp, mountLocation, rewriteHtml, rewriteCss, rewriteJson, rewriteJs, mountLinkHeader } from "./mount.js";
import { createHostProxy, createTickets } from "./proxy.js";

test("paths: under the mount is the app's path; a redirect and a Link header name the mount", () => {
  assert.equal(MOUNT, "/sign/_");
  assert.equal(toApp("/sign/_/s/abc"), "/s/abc");
  assert.equal(toApp("/sign/1/abc"), null);
  assert.equal(mountLocation("/s/abc"), "/sign/_/s/abc");
  assert.equal(mountLocation("/sign/_/s/abc"), "/sign/_/s/abc");
  assert.equal(mountLocation("https://elsewhere.example/x"), "https://elsewhere.example/x");
  assert.equal(mountLocation("//cdn.example/x"), "//cdn.example/x");
  assert.equal(mountLinkHeader("</packs/css/a.css>; rel=preload; as=style, </packs/js/b.js>; rel=preload"), "</sign/_/packs/css/a.css>; rel=preload; as=style, </sign/_/packs/js/b.js>; rel=preload");
});

test("html: attributes, the app's JSON in them, url() and its own-host addresses go under the mount, once; other hosts and protocol-relative links are left", () => {
  const html = '<link href="/packs/a.css"><img src="https://harlow.vyre.run/disk/x/0.png"><a href="/s/abc/download">d</a><div data-v="{&quot;url&quot;:&quot;/disk/y&quot;}"></div><style>b{background:url(/fonts/f.otf)}</style><a href="//cdn.example/x">c</a><a href="https://other.example/s/1">o</a>';
  const out = rewriteHtml(html, "harlow.vyre.run");
  assert.equal(out, '<link href="/sign/_/packs/a.css"><img src="https://harlow.vyre.run/sign/_/disk/x/0.png"><a href="/sign/_/s/abc/download">d</a><div data-v="{&quot;url&quot;:&quot;/sign/_/disk/y&quot;}"></div><style>b{background:url(/sign/_/fonts/f.otf)}</style><a href="//cdn.example/x">c</a><a href="https://other.example/s/1">o</a>');
  assert.equal(rewriteHtml(out, "harlow.vyre.run"), out, "a second pass changes nothing");
});

test("css and json answers: url() and file paths go under the mount", () => {
  assert.equal(rewriteCss('@font-face{src:url("/fonts/a.woff2")}.x{background:url(/packs/media/i.png)}'), '@font-face{src:url("/sign/_/fonts/a.woff2")}.x{background:url(/sign/_/packs/media/i.png)}');
  assert.equal(rewriteJson('{"url":"/disk/abc/0.png","u2":"https://harlow.vyre.run/disk/z","name":"/not-a-path"}', "harlow.vyre.run"), '{"url":"/sign/_/disk/abc/0.png","u2":"https://harlow.vyre.run/sign/_/disk/z","name":"/not-a-path"}');
});

test("script: the webpack public path and the form's baseUrl prop go under the mount; a script with a prop in a shape not known is refused", () => {
  const js = 'x.p="/packs/";const P={baseUrl:{type:String,required:!1,default:""},other:1}';
  assert.equal(rewriteJs(js), 'x.p="/sign/_/packs/";const P={baseUrl:{type:String,required:!1,default:"/sign/_"},other:1}');
  assert.equal(rewriteJs("console.log(1)"), "console.log(1)", "a script that builds no requests is left");
  assert.equal(rewriteJs("const P={baseUrl:{type:String,default:'x'}}"), null, "a changed shape is said, not guessed");
});

/** A front with a fake signing app behind it, served for the Space's own address. */
async function front(t) {
  const seen = /** @type {string[]} */ ([]);
  const up = http.createServer((q, r) => {
    seen.push(`${q.method} ${q.url} ${q.headers.cookie || ""}`);
    if (q.url === "/s/abc") { r.writeHead(200, { "content-type": "text/html", link: "</packs/css/a.css>; rel=preload" }); r.end('<html><head></head><body><a href="/s/abc/download">d</a><img src="https://harlow.vyre.run/disk/1/p.png"></body></html>'); return; }
    if (q.url === "/packs/js/form-1.js") { r.writeHead(200, { "content-type": "application/javascript" }); r.end('x.p="/packs/";const P={baseUrl:{type:String,required:!1,default:""}}'); return; }
    if (q.url === "/packs/js/odd.js") { r.writeHead(200, { "content-type": "application/javascript" }); r.end("const P={baseUrl:{type:String,default:1}}"); return; }
    if (q.url === "/s/abc/upload" && q.method === "POST") { r.writeHead(200, { "content-type": "application/json" }); r.end('{"url":"/disk/abc/s.png"}'); return; }
    if (q.url === "/s/gone") { r.writeHead(302, { location: "/s/abc" }); r.end(); return; }
    if (q.url === "/api/user") { r.writeHead(200); r.end("{}"); return; }
    r.writeHead(404); r.end();
  });
  await new Promise(r => up.listen(0, "127.0.0.1", () => r(undefined)));
  const signing = { routes: [{ methods: ["GET"], path: "/s/:slug" }, { methods: ["GET", "POST"], path: "/s/:slug/*" }, { methods: ["GET"], path: "/packs/*" }, { methods: ["GET"], path: "/disk/*" }], redirects: [{ from: "/sign/:submission/:slug", to: "/s/:slug" }] };
  const tickets = createTickets();
  const origin = `http://127.0.0.1:${/** @type {any} */ (up.address()).port}`;
  const serve = createHostProxy({ tickets, log: () => {}, sign: async () => ({ host: "harlow.vyre.run", name: "documents" }), app: async n => (n === "documents" ? { origin, origins: [origin], login: null, public: [], signing, credentials: async () => ({}) } : null) });
  const fr = http.createServer((q, s) => { serve(q, s, { url: new URL(q.url || "/", "http://x") }).then(d => { if (!d) { s.writeHead(404); s.end("not found"); } }); });
  await new Promise(r => fr.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { fr.close(); up.close(); });
  const port = /** @type {any} */ (fr.address()).port;
  const get = (/** @type {string} */ p, /** @type {string} */ host = "harlow.vyre.run", /** @type {Record<string, string>} */ h = {}, method = "GET") => new Promise(resolve => { const rq = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host, ...h } }, res => { const c = /** @type {Buffer[]} */ ([]); res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() })); }); rq.end(); });
  return { get, seen };
}

test("the front: the pretty link goes to the page under the mount; the page, its script and its answers come back under it; a path outside it is not the app's", async t => {
  const { get, seen } = await front(t);
  /** @type {any} */ const pretty = await get("/sign/7/abc");
  assert.deepEqual([pretty.status, pretty.headers.location], [302, "/sign/_/s/abc"]);
  /** @type {any} */ const page = await get("/sign/_/s/abc");
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/sign\/_\/s\/abc\/download"/);
  assert.match(page.text, /src="https:\/\/harlow\.vyre\.run\/sign\/_\/disk\/1\/p\.png"/);
  assert.match(page.text, /<link rel="stylesheet" href="\/sign\/_\/__vyre\/brand\.css">/, "Vyre's look is laid over it from under the mount");
  assert.equal(page.headers.link, "</sign/_/packs/css/a.css>; rel=preload");
  /** @type {any} */ const js = await get("/sign/_/packs/js/form-1.js");
  assert.equal(js.text, 'x.p="/sign/_/packs/";const P={baseUrl:{type:String,required:!1,default:"/sign/_"}}');
  assert.equal(js.headers["content-length"], String(Buffer.byteLength(js.text)));
  /** @type {any} */ const odd = await get("/sign/_/packs/js/odd.js");
  assert.equal(odd.status, 404, "the route list does not open it");
  /** @type {any} */ const up = await get("/sign/_/s/abc/upload", "harlow.vyre.run", {}, "POST");
  assert.equal(up.text, '{"url":"/sign/_/disk/abc/s.png"}');
  /** @type {any} */ const jump = await get("/sign/_/s/gone");
  assert.equal(jump.status, 404, "a path the signing routes do not list is not served");
  /** @type {any} */ const css = await get("/sign/_/__vyre/brand.css");
  assert.equal(css.status, 200);
  // the Space's root and anything but a signer's route is not the app's, and the app's own admin paths are not reachable through the mount
  assert.equal((await get("/")).status, 404);
  assert.equal((await get("/sign/_/api/user")).status, 404);
  assert.equal((await get("/sign/_/s/abc", "documents.harlow.vyre.run")).status, 404, "the mount is the Space's address only, and the app's own host has no /sign/_");
  assert.equal((await get("/sign/_/s/abc", "other.example")).status, 404);
  assert.ok(seen.every(l => !l.includes("/sign/_")), "the app never sees the mount in a path");
});

test("the front: an owner's cookie is not honoured under the mount, and nothing of Vyre's reaches the app", async t => {
  const { get, seen } = await front(t);
  await get("/sign/_/s/abc", "harlow.vyre.run", { cookie: "vyre_app=FORGED; _app=1" });
  assert.ok(seen[0].endsWith(" _app=1"), `only the signer's own cookie reached the app: ${seen[0]}`);
  assert.ok(!seen[0].includes("vyre_app"));
});
