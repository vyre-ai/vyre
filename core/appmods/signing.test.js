// @ts-check
// Public signing pages (R032-02): a signer reaches only the routes the manifest lists, as a stranger to the app (never the install's admin session), sees Vyre's look and the app's credit, and the owner
// keeps everything else. The app is a stand-in server that reports what it was sent.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { compile, matcher, dress, signerCookies, handOn, CREDIT_HTML, CREDIT_CSS, mintLink, checkLink, filePaths, EXPIRED_HTML, requestBody, readRequest } from "./signing.js";
import crypto from "node:crypto";
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
  assert.ok(disk.test("/disk/eyJfcmFpbHMiOnsiZGF0YSI6e30=--0a1b2c/0.png"));
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
  for (const [method, path] of [["GET", "/s/xYz123"], ["PUT", "/s/xYz123"], ["POST", "/s/xYz123"], ["POST", "/api/attachments"], ["GET", "/packs/js/application.js"], ["GET", "/file/abc/def/Contract.pdf"], ["GET", "/disk/eyJfcmFpbHMiOnsiZGF0YSI6e30=--0a1b2c/0.png"], ["POST", "/s/xYz123/decline"]]) assert.ok(m.open(method, path), `${method} ${path}`);
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
      if (/^\/s\/[A-Za-z0-9_-]+\/documents$/.test(req.url || "")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify([{ name: "proof.pdf", url: "/file/WyJ1dWlkIl0--abc/proof.pdf" }, { url: "/file/WyJ1dWlkMiJd--def/second.pdf" }])); }
      if ((req.url || "").startsWith("/file/")) { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF-1.7 signed " + req.url); }
      if ((req.url || "").startsWith("/s/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": set, "content-security-policy": "style-src 'self'" }); return res.end("<html><head><title>Sign</title></head><body><h1>Sign here</h1></body></html>"); }
      res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head></head><body>admin page</body></html>");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { origin, seen };
}

const KEY = Buffer.alloc(32, 7);
async function front(t, { brand = async () => "", now = () => Date.now() } = {}) {
  const a = await app(t);
  const tickets = createTickets();
  const proxy = createHostProxy({ tickets, brand, now, linkKey: name => (name === "documents" ? KEY : null), app: async name => (name === "documents" ? { origin: a.origin, origins: [a.origin], login: { path: "/sign_in", token: "authenticity_token", fields: { "user[email]": "{login_email}" }, ok: [302] }, public: ["/manifest.json"], signing: manifest.app.signing, credentials: async () => ({ login_email: "owner@example.test" }) } : null) });
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
  assert.equal(r.headers["referrer-policy"], "same-origin");
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
  for (const [m, p] of [["GET", "/"], ["GET", "/templates"], ["GET", "/submissions"], ["GET", "/api/submissions"], ["POST", "/api/submissions"], ["POST", "/s/abc/delegate"], ["DELETE", "/s/abc"], ["GET", "/settings/api"]]) {
    const r = await f.call(m, p);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(f.a.seen.length, 0, "the app was not touched");
});

test("a signer's actions go through: the submit, the decline, the signature upload; the pretty link redirects", async t => {
  const f = await front(t);
  assert.equal((await f.call("PUT", "/s/abc123", {}, '{"values":[]}')).status, 200);
  assert.equal((await f.call("POST", "/s/abc123", {}, "_method=put")).status, 200, "a browser's form posts the submit and tells Rails it is a PUT");
  assert.equal((await f.call("POST", "/s/abc123/decline", {}, "{}")).status, 200);
  assert.equal((await f.call("POST", "/api/attachments", {}, "x")).status, 200);
  const red = await f.call("GET", "/sign/4411/abc123");
  assert.equal(red.status, 302);
  assert.equal(red.headers.location, "/s/abc123");
  assert.equal(f.a.seen.filter(s => s.url === "/s/abc123").length, 2, "only the two submits reached the app (the PUT and the browser's POST); the redirect did not touch it");
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

test("a link to the signed copy is made under a key, ends on its day, and is checked in constant time", () => {
  const exp = Date.UTC(2026, 10, 10);
  const token = mintLink(KEY, "abc123", exp);
  assert.deepEqual(checkLink(KEY, token, exp - 1000), { ok: true, slug: "abc123" });
  assert.deepEqual(checkLink(KEY, token, exp + 1000), { ok: false, expired: true });
  assert.deepEqual(checkLink(Buffer.alloc(32, 8), token, exp - 1000), { ok: false, expired: false }, "another key");
  const [e, , m] = token.split(".");
  for (const bad of [`${e}.other.${m}`, `${Number(e) + 99999}.abc123.${m}`, "", "x.y.z", `${e}.abc123.${m}x`]) assert.equal(checkLink(KEY, bad, exp - 1000).ok, false, bad);
  assert.throws(() => mintLink(KEY, "../x", exp), /slug/);
  assert.deepEqual(filePaths([{ url: "/file/AA==--b/proof.pdf" }, { url: "/s/x/documents" }, { nested: { u: "/blobs_proxy/id/c/d.pdf" } }, { u: "/file/x/../etc" }, "javascript:1"]), ["/file/AA==--b/proof.pdf", "/blobs_proxy/id/c/d.pdf"]);
});

test("a link with no end opens the signed copy years later, only for the key it was made under, and cannot be given an end by changing it", async t => {
  const forever = mintLink(KEY, "abc123", null);
  assert.match(forever, /^0\.abc123\.[A-Za-z0-9_-]{43}$/);
  for (const when of [Date.UTC(2026, 9, 10), Date.UTC(2026, 10, 10) + 31 * 86_400_000, Date.UTC(2046, 0, 1)]) assert.deepEqual(checkLink(KEY, forever, when), { ok: true, slug: "abc123" }, new Date(when).toISOString());
  const m = forever.split(".")[2];
  // the end is under the MAC: neither a made-up end nor another signer's slug passes, and another key (the links were ended) refuses it
  for (const bad of [`9999999999.abc123.${m}`, `0.other.${m}`, `1.abc123.${m}`]) assert.equal(checkLink(KEY, bad, 0).ok, false, bad);
  assert.deepEqual(checkLink(Buffer.alloc(32, 9), forever, 0), { ok: false, expired: false });
  // through the real front, after 31 days and after ten years
  let now = Date.UTC(2026, 9, 10);
  const g = await front(t, { now: () => now });
  now += 31 * 86_400_000;
  assert.equal((await g.call("GET", `/signed/${forever}`)).status, 200, "still opens after 31 days");
  now += 10 * 365 * 86_400_000;
  assert.equal((await g.call("GET", `/signed/${forever}`)).status, 200, "and after ten years");
  assert.equal((await g.call("GET", "/s/abc123/documents")).status, 404, "the slug alone still does not reach the file");
});

test("the signed copy opens only by its link: the slug no longer lists or downloads it, an expired link says so, a bad one is a 404", async t => {
  let now = Date.UTC(2026, 9, 10);
  const f = await front(t, { now: () => now });
  const token = mintLink(KEY, "abc123", now + 30 * 86_400_000);
  // the signer's slug alone does not reach the finished file
  for (const p of ["/s/abc123/documents", "/s/abc123/download"]) assert.equal((await f.call("GET", p)).status, 404, p);
  const ok = await f.call("GET", `/signed/${token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "application/pdf");
  assert.match(ok.headers["content-disposition"], /attachment; filename="proof\.pdf"/);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.match(ok.body, /^%PDF-1\.7 signed \/file\/WyJ1dWlkIl0--abc\/proof\.pdf/);
  assert.match((await f.call("GET", `/signed/${token}/1`)).body, /second\.pdf/, "the second file of the document");
  assert.equal((await f.call("GET", `/signed/${token}/5`)).status, 404);
  // no ticket, no admin: the app saw the listing and the file as a stranger
  assert.ok(f.a.seen.filter(s => s.url.startsWith("/s/abc123/documents") || s.url.startsWith("/file/")).every(s => !/_admin/.test(s.cookie)));
  assert.ok(!f.a.seen.some(s => s.url === "/sign_in"), "the proxy did not sign in for it");
  const [e, , m] = token.split(".");
  assert.equal((await f.call("GET", `/signed/${e}.other.${m}`)).status, 404, "a link made for one signer opens nothing of another's");
  assert.equal((await f.call("GET", "/signed/nonsense")).status, 404);
  now += 31 * 86_400_000;
  const gone = await f.call("GET", `/signed/${token}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.body, EXPIRED_HTML);
  assert.ok(!gone.body.includes("abc123"), "the expired page does not repeat the slug");
  void crypto;
});

test("a signing request tells the app to send nothing, and the answer is read for the signer's number and slug only", () => {
  assert.deepEqual(requestBody(12, "dana@harlow.test", "Dana Harlow"), { template_id: 12, send_email: false, submitters: [{ email: "dana@harlow.test", name: "Dana Harlow" }] });
  assert.deepEqual(requestBody(12, "dana@harlow.test").submitters, [{ email: "dana@harlow.test" }]);
  for (const bad of [[0, "a@b.test"], [1.5, "a@b.test"], [12, "nope"], [12, "a@b.test, c@d.test"], [12, "a b@c.test"]]) assert.throws(() => requestBody(/** @type {any} */ (bad[0]), /** @type {any} */ (bad[1])));
  assert.deepEqual(readRequest([{ id: 7, submission_id: 4411, slug: "abc123" }]), { submission: 4411, slug: "abc123" });
  assert.deepEqual(readRequest({ submitters: [{ submission_id: 5, slug: "x_y-z" }] }), { submission: 5, slug: "x_y-z" });
  for (const junk of [null, [], [{}], [{ submission_id: 0, slug: "a" }], [{ submission_id: 4, slug: "../x" }], "text"]) assert.equal(readRequest(junk), null);
});

test("the stylesheet every signer page carries hides what the signer's link cannot serve and the engine's own branding, and keeps the licence credit", () => {
  assert.match(CREDIT_CSS, /download-button[^}]*display:none/, "no Download button: the signed copy comes by its own link");
  assert.match(CREDIT_CSS, /a\[href\*="docuseal\.com"\][^}]*display:none/, "the engine's logo and powered-by links are not shown");
  assert.ok(!/#vyre-credit[^{]*\{[^}]*display:none/.test(CREDIT_CSS), "the licence credit stays");
  assert.ok(CREDIT_HTML.includes("github.com/docusealco/docuseal") && !CREDIT_HTML.includes("docuseal.com"), "and its link is not one the stylesheet hides");
});
