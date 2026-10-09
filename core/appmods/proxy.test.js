import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { moduleHost, originFor, rewriteLocation, keepCookies, cookieHeader, createTickets, ENTER } from "./proxy.js";

test("a host under an app's name splits into the app and the host Vyre is served at; anything else is not an app's", () => {
  assert.deepEqual(moduleHost("documents.acme.vyre.run"), { name: "documents", base: "acme.vyre.run" });
  assert.deepEqual(moduleHost("Documents.localhost:8080"), { name: "documents", base: "localhost:8080" });
  for (const h of ["localhost:8080", "127.0.0.1:80", "", "x.y", "1abc.example.com", "docu_seal.example.com"]) assert.equal(moduleHost(h), null, h);
  assert.deepEqual(moduleHost("acme.vyre.run"), { name: "acme", base: "vyre.run" }, "any host with a first label looks like one; whether an app of that name is installed decides");
});

test("the app's origin is https on a real host and http on localhost", () => {
  assert.equal(originFor("documents", "acme.vyre.run"), "https://documents.acme.vyre.run");
  assert.equal(originFor("documents", "localhost:8080"), "http://documents.localhost:8080");
  assert.equal(originFor("documents", "https://acme.vyre.run"), "https://documents.acme.vyre.run");
});

test("a redirect to the app's own address is put back on the origin the person is on; another host is left alone", () => {
  const o = ["http://127.0.0.1:4000", "http://localhost:3000"], here = "https://documents.acme.vyre.run";
  assert.equal(rewriteLocation("http://127.0.0.1:4000/templates/1?a=1", o, here), "https://documents.acme.vyre.run/templates/1?a=1");
  assert.equal(rewriteLocation("http://localhost:3000", o, here), here);
  assert.equal(rewriteLocation("/dashboard", o, here), "/dashboard");
  assert.equal(rewriteLocation("https://elsewhere.example/x", o, here), "https://elsewhere.example/x");
  assert.equal(rewriteLocation("http://localhost:30001/x", o, here), "http://localhost:30001/x", "a different port is a different origin");
});

test("the app's cookies are kept in a jar and removed when it expires them", () => {
  const jar = new Map();
  keepCookies(jar, ["_s=abc; path=/; HttpOnly", "other=1; Max-Age=3600"]);
  assert.equal(cookieHeader(jar), "_s=abc; other=1");
  keepCookies(jar, ["other=; Max-Age=0; path=/"]);
  keepCookies(jar, ["_s=zzz; Expires=Wed, 21 Oct 2015 07:28:00 GMT"]);
  assert.equal(cookieHeader(jar), "");
});

test("a ticket is good once, for a minute, only at the host it was made for; its session only for that app at that host", () => {
  let t = 1000;
  const k = createTickets({ now: () => t });
  const a = k.issue("documents", "documents.acme.vyre.run", "/templates");
  assert.equal(k.trade(a, "documents.other.example"), null, "another host cannot spend it");
  assert.equal(k.trade(a, "documents.acme.vyre.run"), null, "and a spent or wrong-host ticket is gone");
  const b = k.issue("documents", "documents.acme.vyre.run", "/templates");
  const got = k.trade(b, "documents.acme.vyre.run");
  assert.equal(got.next, "/templates");
  assert.equal(k.trade(b, "documents.acme.vyre.run"), null, "once");
  assert.equal(k.valid(got.sid, "documents", "documents.acme.vyre.run"), true);
  assert.equal(k.valid(got.sid, "other", "documents.acme.vyre.run"), false);
  assert.equal(k.valid(got.sid, "documents", "documents.evil.example"), false);
  assert.equal(k.valid(undefined, "documents", "documents.acme.vyre.run"), false);
  const c = k.issue("documents", "h.x", "/"); t += 61_000;
  assert.equal(k.trade(c, "h.x"), null, "a minute is all it gets");
  t += 9 * 3_600_000;
  assert.equal(k.valid(got.sid, "documents", "documents.acme.vyre.run"), false, "a session ends");
  const d = k.issue("documents", "h.x", "/"); const s = k.trade(d, "h.x"); k.drop("documents");
  assert.equal(k.valid(s.sid, "documents", "h.x"), false, "removing the app ends its sessions");
  assert.equal(ENTER, "/__vyre/enter");
});

test("a signed-in session survives a restart when a store keeps it (by the hash of the cookie), ends at its time, and is dropped with its name", () => {
  /** @type {Map<string, any>} */ const rows = new Map();
  const store = { put: (/** @type {string} */ h, /** @type {any} */ r) => rows.set(h, r), get: (/** @type {string} */ h) => rows.get(h) || null, dropName: (/** @type {string} */ n) => { for (const [k, v] of rows) if (v.name === n) rows.delete(k); }, sweep: (/** @type {number} */ t) => { for (const [k, v] of rows) if (v.exp < t) rows.delete(k); } };
  let at = 1_000_000;
  const a = createTickets({ now: () => at, store });
  const t = a.issue("pv-0a1b2c3d", "pv-0a1b2c3d.localhost", "/", { w: "per_a", r: "member" });
  const got = a.trade(t, "pv-0a1b2c3d.localhost");
  assert.ok(got);
  assert.ok(![...rows.keys()].includes(got.sid), "the cookie itself is never kept, only its hash");
  assert.equal(rows.size, 1);
  // a new process: no memory, the same store
  const b = createTickets({ now: () => at + 60_000, store });
  assert.equal(b.valid(got.sid, "pv-0a1b2c3d", "pv-0a1b2c3d.localhost"), true, "still signed in after a restart");
  assert.deepEqual(b.whoOf(got.sid), { w: "per_a", r: "member" });
  assert.equal(b.valid(got.sid, "pv-0a1b2c3d", "other.localhost"), false, "only at its own host");
  assert.equal(b.valid("not-a-session", "pv-0a1b2c3d", "pv-0a1b2c3d.localhost"), false);
  // its time
  const later = createTickets({ now: () => at + 9 * 3_600_000, store });
  assert.equal(later.valid(got.sid, "pv-0a1b2c3d", "pv-0a1b2c3d.localhost"), false, "eight hours is eight hours");
  // access taken away: dropped everywhere
  b.drop("pv-0a1b2c3d");
  assert.equal(createTickets({ now: () => at, store }).valid(got.sid, "pv-0a1b2c3d", "pv-0a1b2c3d.localhost"), false);
});

test("a frame's address gets a cookie that works inside a frame (SameSite=None; Secure; Partitioned); an ordinary one stays Lax", async () => {
  const { createHostProxy } = await import("./proxy.js");
  const http = await import("node:http");
  const up = http.createServer((_q, r) => { r.writeHead(200, { "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src data:" }); r.end("page"); });
  await new Promise(r => up.listen(0, "127.0.0.1", () => r(undefined)));
  const tickets = createTickets();
  const serve = createHostProxy({ tickets, app: async (n) => (n === "pv-0a1b2c3d" ? { origin: `http://127.0.0.1:${/** @type {any} */ (up.address()).port}`, origins: [], login: null, public: [], rewriteHost: true, passCookies: true, allowEmbed: true, credentials: async () => ({}) } : null) });
  const front = http.createServer((q, s) => { serve(q, s, { url: new URL(q.url || "/", "http://x") }).then(d => { if (!d) { s.writeHead(404); s.end(); } }); });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (front.address()).port;
  const get = (/** @type {string} */ p, /** @type {Record<string, string>} */ h = {}) => new Promise(resolve => { http.get({ host: "127.0.0.1", port, path: p, headers: { host: "pv-0a1b2c3d.vyre.test", ...h } }, res => { res.resume(); res.on("end", () => resolve(res)); }); });
  try {
    const embed = /** @type {any} */ (await get(`${ENTER}?t=${tickets.issue("pv-0a1b2c3d", "pv-0a1b2c3d.vyre.test", "/", { w: "p", r: "owner" }, true)}`));
    assert.match(String(embed.headers["set-cookie"]), /SameSite=None; Secure; Partitioned/);
    const plain = /** @type {any} */ (await get(`${ENTER}?t=${tickets.issue("pv-0a1b2c3d", "pv-0a1b2c3d.vyre.test", "/", { w: "p", r: "owner" }, false)}`));
    assert.match(String(plain.headers["set-cookie"]), /SameSite=Lax/);
    assert.ok(!/None/.test(String(plain.headers["set-cookie"])));
    const cookie = String(embed.headers["set-cookie"]).split(";")[0];
    const page = /** @type {any} */ (await get("/", { cookie }));
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["x-frame-options"], undefined, "the page's wish not to be framed does not apply to Vyre's own app");
    assert.ok(!/frame-ancestors/.test(String(page.headers["content-security-policy"])), "nor its frame-ancestors");
    assert.match(String(page.headers["content-security-policy"]), /default-src 'self'.*img-src data:/, "the rest of its policy is kept");
  } finally { front.close(); up.close(); }
});
