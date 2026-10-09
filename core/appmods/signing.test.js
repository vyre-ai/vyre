// @ts-check
// Public signing pages (R032-02): a signer reaches only the routes the manifest lists, as a stranger to the app (never the install's admin session), sees Vyre's look and the app's credit, and the owner
// keeps everything else. The app is a stand-in server that reports what it was sent.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { compile, matcher, dress, signerCookies, handOn, CREDIT_HTML } from "./signing.js";
import { createHostProxy, createTickets, BRAND_CSS } from "./proxy.js";
import { signingBrand, resolveBrand, normalizeBrand } from "../../lib/brand/profile.js";
import manifest from "./catalog/documents.json" with { type: "json" };

const HOST = "documents.acme.vyre.run";

test("a route pattern matches exactly: :name is one segment, a trailing /* is the rest, nothing climbs", () => {
  assert.ok(compile("/s/:slug").test("/s/abc_DEF-123"));
  assert.ok(!compile("/s/:slug").test("/s/abc/def"));
  assert.ok(!compile("/s/:slug").test("/s/"));
  assert.ok(!compile("/s/:slug").test("/s/a.b"), "a segment is letters, digits, - and _");
  assert.ok(compile("/file/:id/*").test("/file/xyz/signed/Contract.pdf"));
  assert.ok(!compile("/file/:id/*").test("/file/xyz/../etc"));
  assert.ok(!compile("/file/:id/*").test("/file/xyz"));
  const disk = compile("/disk/:blob/*");
  assert.ok(disk.test("/disk/eyJfcmFpbHMiOnsiZGF0YSI6e30=--0a1b2c/0.png") && !disk.test("/disk/a%2Fb/x") === true);
  assert.ok(!compile("/s/:slug").test("/s/a=b"), "only :blob takes a token's = ");
  assert.ok(!compile("/file/:id/*").test("/file/xyz/./a") && !compile("/file/:id/*").test("/file/xyz/a/.."));
  assert.ok(compile("/file/:id/*").test("/file/xyz/My%20Contract.v2.pdf"));
  // an encoded dot, slash, backslash or NUL never passes the matcher, whatever the pattern says
  const enc = matcher({ routes: [{ methods: ["GET"], path: "/file/:id/*" }] });
  for (const p of ["/file/xyz/%2e%2e/admin", "/file/xyz/a%2Fb", "/file/xyz/a%5cb", "/file/xyz/a%00b", "/file/xyz/%2E%2E/x"]) assert.ok(!enc.open("GET", p), p);
  for (const bad of ["s/x", "/s/../x", "/a//b", "/a/*/b", "/a/:Bad", "/s/:slug;x"]) assert.throws(() => compile(bad), /not a signing route|may only end/, bad);
});

test("the matcher is by method and path, and a pretty link goes to the page", () => {
  const m = matcher({ routes: [{ methods: ["GET", "HEAD", "PUT"], path: "/s/:slug" }, { methods: ["POST"], path: "/s/:slug/decline" }], redirects: [{ from: "/sign/:submission/:slug", to: "/s/:slug" }] });
  assert.ok(m.open("GET", "/s/abc") && m.open("put", "/s/abc") && m.open("POST", "/s/abc/decline"));
  assert.ok(!m.open("POST", "/s/abc") && !m.open("GET", "/s/abc/decline") && !m.open("DELETE", "/s/abc") && !m.open("GET", "/templates"));
  assert.equal(m.redirect("/sign/4411/abc123"), "/s/abc123");
  assert.equal(m.redirect("/sign/4411"), null);
  assert.equal(m.redirect("/s/abc"), null);
});

test("the Documents manifest lists the signer's routes and no admin path", () => {
  const sign = manifest.app.signing;
  const m = matcher(sign);
  for (const [method, path] of [["GET", "/s/xYz123"], ["PUT", "/s/xYz123"], ["POST", "/api/attachments"], ["GET", "/packs/js/application.js"], ["GET", "/file/abc/def/Contract.pdf"], ["GET", "/disk/eyJfcmFpbHMiOnsiZGF0YSI6e30=--0a1b2c/0.png"], ["POST", "/s/xYz123/decline"]]) assert.ok(m.open(method, path), `${method} ${path}`);
  for (const [method, path] of [["GET", "/"], ["GET", "/templates"], ["GET", "/submissions"], ["GET", "/settings/api"], ["GET", "/api/submissions"], ["POST", "/api/submissions"], ["GET", "/api/templates"], ["GET", "/users"], ["POST", "/s/xYz123/invite"], ["POST", "/s/xYz123/delegate"], ["GET", "/sign_in"], ["GET", "/d/abc"], ["GET", "/mcp"], ["DELETE", "/s/xYz123"]]) assert.ok(!m.open(method, path), `${method} ${path} must not be public`);
  assert.equal(m.redirect("/sign/12/abc"), "/s/abc");
});

test("a page is dressed with one stylesheet link and the credit; the signer's cookies keep only the app's own", () => {
  const page = dress("<html><head><title>x</title></head><body><p>hi</p></body></html>", BRAND_CSS);
  assert.match(page, /<link rel="stylesheet" href="\/__vyre\/brand\.css"><\/head>/);
  assert.ok(page.includes(CREDIT_HTML + "</body>"));
  assert.ok(!/<script/i.test(page.replace(/<title>.*<\/title>/, "")), "no script added");
  assert.ok(dress("<p>bare</p>", "/x.css").endsWith(CREDIT_HTML));
  assert.equal(signerCookies("_ds=abc; vyre_app=SECRET; other=1; vyre_x=y"), "_ds=abc; other=1");
  assert.equal(handOn("_ds=abc; Path=/; Domain=127.0.0.1; HttpOnly"), "_ds=abc; Path=/; HttpOnly");
});

test("the brand becomes a stylesheet: the colour for buttons and links, a band with the logo and name, plain text only", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const n = normalizeBrand({ name: 'Harlow "Legal"', colors: { primary: "#3A5BA0" }, logos: { light: png }, fonts: { body: "serif" } });
  assert.ok(n.ok);
  const css = signingBrand(resolveBrand(/** @type {any} */ (n).profile));
  assert.match(css, /--p:\d+ \d+% \d+%/);
  assert.match(css, /body::before\{content:"Harlow \\"Legal\\""/);
  assert.ok(css.includes(`url("${png}")`));
  assert.match(css, /Georgia/);
  assert.equal(signingBrand(resolveBrand({})), "", "no brand, no rules (the credit style is always sent)");
});

/** The app: reports every request and answers like a Rails app that wants a login for its admin pages. */
async function app(t) {
  /** @type {any[]} */ const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on("data", c => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || "", enc: req.headers["accept-encoding"] || "", bodyBytes: Buffer.concat(chunks).length });
      const set = ["_ds=signer1; Path=/; Domain=127.0.0.1; HttpOnly"];
      if (req.url === "/sign_in" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<input name="authenticity_token" value="tok1">'); }
      if (req.url === "/sign_in" && req.method === "POST") { res.writeHead(302, { location: "/", "set-cookie": ["_admin=ADMIN-SESSION; Path=/"] }); return res.end(); }
      if ((req.url || "").startsWith("/s/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": set, "content-security-policy": "style-src 'self'" }); return res.end("<html><head><title>Sign</title></head><body><h1>Sign here</h1></body></html>"); }
      res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head></head><body>admin page</body></html>");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { origin, seen };
}

async function front(t, { brand = async () => "" } = {}) {
  const a = await app(t);
  const tickets = createTickets();
  const proxy = createHostProxy({ tickets, brand, app: async name => (name === "documents" ? { origin: a.origin, origins: [a.origin], login: { path: "/sign_in", token: "authenticity_token", fields: { "user[email]": "{login_email}" }, ok: [302] }, public: ["/manifest.json"], signing: manifest.app.signing, credentials: async () => ({ login_email: "owner@example.test" }) } : null) });
  const server = http.createServer((req, res) => { proxy(req, res, { url: new URL(req.url || "/", "http://x") }).then(done => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = /** @type {any} */ (server.address()).port;
  const call = (/** @type {string} */ method, /** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, res => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8") })); });
    r.on("error", reject); r.end(body);
  });
  const sid = () => { const tk = tickets.issue("documents", HOST, "/"); return `vyre_app=${tickets.trade(tk, HOST)?.sid}`; };
  return { a, call, sid, port };
}

test("a signer opens the page with no ticket: dressed, credited, uncached, and the app sees a stranger, never the admin", async t => {
  const f = await front(t, { brand: async () => "body{outline:1px solid red}" });
  const r = await f.call("GET", "/s/abc123", { cookie: "_ds=mine; vyre_app=FORGED" });
  assert.equal(r.status, 200);
  assert.match(r.body, /Sign here/);
  assert.match(r.body, /<link rel="stylesheet" href="\/__vyre\/brand\.css">/);
  assert.ok(r.body.includes("Signatures by"));
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.match(String(r.headers["x-robots-tag"]), /noindex/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.deepEqual(r.headers["set-cookie"], ["_ds=signer1; Path=/; HttpOnly"], "the signer's cookie goes back to the signer, without its Domain");
  const hit = f.a.seen.find(s => s.url === "/s/abc123");
  assert.equal(hit.cookie, "_ds=mine", "only the signer's own cookie; neither ours nor the admin session");
  assert.equal(hit.enc, "identity");
  assert.ok(!f.a.seen.some(s => s.url === "/sign_in"), "the proxy did not even sign in to the app for a stranger");
  const css = await f.call("GET", BRAND_CSS);
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /text\/css/);
  assert.ok(css.body.includes("#vyre-credit") && css.body.includes("outline:1px solid red"));
});

test("what is not on the list is a plain 404 to a stranger and never reaches the app", async t => {
  const f = await front(t);
  for (const [m, p] of [["GET", "/"], ["GET", "/templates"], ["GET", "/submissions"], ["GET", "/api/submissions"], ["POST", "/api/submissions"], ["POST", "/s/abc/delegate"], ["POST", "/s/abc"], ["DELETE", "/s/abc"], ["GET", "/settings/api"]]) {
    const r = await f.call(m, p);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(f.a.seen.length, 0, "the app was not touched");
});

test("a signer's actions go through: the submit, the decline, the signature upload; the pretty link redirects", async t => {
  const f = await front(t);
  assert.equal((await f.call("PUT", "/s/abc123", {}, '{"values":[]}')).status, 200);
  assert.equal((await f.call("POST", "/s/abc123/decline", {}, "{}")).status, 200);
  assert.equal((await f.call("POST", "/api/attachments", {}, "x")).status, 200);
  const red = await f.call("GET", "/sign/4411/abc123");
  assert.equal(red.status, 302);
  assert.equal(red.headers.location, "/s/abc123");
  assert.equal(f.a.seen.filter(s => s.url === "/s/abc123").length, 1, "the redirect did not touch the app");
  // a stranger cannot send a huge body: the declared length is refused before a byte is read, and the app is not touched
  const before = f.a.seen.length;
  const status = await new Promise(resolve => {
    const port = f.port;
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/attachments", headers: { host: HOST, "content-length": String(21 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode); r.destroy(); });
    r.on("error", () => resolve(null));
    r.write("x");
  });
  assert.equal(status, 413);
  assert.equal(f.a.seen.length, before);
});

test("the owner keeps everything: with a ticket the admin pages open, signed in as the install, and the signer's cookie never reaches the admin jar", async t => {
  const f = await front(t);
  await f.call("GET", "/s/abc123", { cookie: "_ds=mine" });
  const admin = await f.call("GET", "/templates", { cookie: f.sid() });
  assert.equal(admin.status, 200);
  assert.match(admin.body, /admin page/);
  const hit = f.a.seen.find(s => s.url === "/templates");
  assert.match(hit.cookie, /_admin=ADMIN-SESSION/);
  assert.ok(!hit.cookie.includes("_ds=signer1"), "the signer's cookie is not in the admin session");
  assert.ok(!admin.body.includes("Signatures by"), "the owner's pages are not dressed");
});
