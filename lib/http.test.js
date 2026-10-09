// @ts-check
// lib/http.js: the one guarded client for requests that leave the machine.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { httpFetch, HttpError, guardedFetch, allowFor, userHostFetch, autoFetch } from "./http.js";

/** A local server for the transport (allow: "any" lifts the address rule; the rule itself is tested with a lookup). @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
async function server(handler) {
  const hits = /** @type {{ method: string, url: string, headers: any, body: string }[]} */ ([]);
  const s = http.createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { hits.push({ method: String(req.method), url: String(req.url), headers: req.headers, body: b }); handler(req, res); }); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {any} */ (s.address()).port}`;
  return { base, hits, close: () => s.closeAllConnections?.() || s.close() };
}
const any = { allow: /** @type {"any"} */ ("any"), sleep: async () => {}, backoffMs: 1 };

test("a request goes out, the answer comes back as a Response, and the body is what was sent", async t => {
  const s = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  t.after(s.close);
  const r = await httpFetch(`${s.base}/x?a=1`, { ...any, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 1 }) });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(s.hits[0].body, '{"n":1}'); assert.equal(s.hits[0].url, "/x?a=1"); assert.equal(s.hits[0].headers["content-length"], "7");
});

test("the address rule: https only, no credentials in the URL, and every answer must be public", async () => {
  await assert.rejects(() => httpFetch("http://example.com/"), /only https/);
  await assert.rejects(() => httpFetch("https://user:pw@example.com/"), e => e instanceof HttpError && e.code === "credentials_in_url");
  await assert.rejects(() => httpFetch("https://internal.example/", { lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.9" }] }), e => e instanceof HttpError && e.code === "not_public");
  await assert.rejects(() => httpFetch("https://metadata.example/", { lookup: async () => [{ address: "169.254.169.254" }] }), e => e instanceof HttpError && e.code === "not_public");
  await assert.rejects(() => httpFetch("https://127.0.0.1/"), e => e instanceof HttpError && e.code === "not_public");
  await assert.rejects(() => httpFetch("https://[::ffff:7f00:1]/"), e => e instanceof HttpError && e.code === "not_public");
  await assert.rejects(() => httpFetch("not a url"), e => e instanceof HttpError && e.code === "bad_url");
});

test("the size rule: a body over the cap is refused, declared or streamed", async t => {
  const s = await server((req, res) => { if (req.url === "/declared") { res.writeHead(200, { "content-length": "5000" }); res.end(Buffer.alloc(5000)); } else { res.writeHead(200); res.write(Buffer.alloc(3000)); setTimeout(() => res.end(Buffer.alloc(3000)), 20); } });
  t.after(s.close);
  await assert.rejects(() => httpFetch(`${s.base}/declared`, { ...any, maxBytes: 1000, retries: 0 }), e => e.code === "too_large");
  await assert.rejects(() => httpFetch(`${s.base}/stream`, { ...any, maxBytes: 4000, retries: 0 }), e => e.code === "too_large");
  assert.equal((await httpFetch(`${s.base}/stream`, { ...any, maxBytes: 10_000 })).status, 200);
});

test("the time rule: a deadline, and the caller's own signal", async t => {
  const s = await server(() => { /* never answers */ });
  t.after(s.close);
  await assert.rejects(() => httpFetch(`${s.base}/`, { ...any, timeoutMs: 80, retries: 0 }), e => e.code === "timeout");
  const ac = new AbortController(); setTimeout(() => ac.abort(), 30);
  await assert.rejects(() => httpFetch(`${s.base}/`, { ...any, signal: ac.signal, retries: 0 }), e => e.code === "timeout");
});

test("redirects: followed a few times, https never downgraded, credentials dropped across origins, manual and error honoured", async t => {
  const b = await server((req, res) => { res.writeHead(200); res.end("b:" + (req.headers.authorization || "no-auth")); });
  const a = await server((req, res) => {
    if (req.url === "/same") { res.writeHead(302, { location: "/final" }); res.end(); }
    else if (req.url === "/final") { res.writeHead(200); res.end("a:" + (req.headers.authorization || "no-auth")); }
    else if (req.url === "/cross") { res.writeHead(302, { location: b.base + "/there" }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else if (req.url === "/post") { res.writeHead(303, { location: "/final" }); res.end(); }
  });
  t.after(a.close); t.after(b.close);
  const h = { authorization: "Bearer secret" };
  assert.equal(await (await httpFetch(a.base + "/same", { ...any, headers: h })).text(), "a:Bearer secret", "same origin keeps the header");
  assert.equal(await (await httpFetch(a.base + "/cross", { ...any, headers: h })).text(), "b:no-auth", "another origin does not get it");
  await assert.rejects(() => httpFetch(a.base + "/loop", any), e => e.code === "too_many_redirects");
  assert.equal((await httpFetch(a.base + "/same", { ...any, redirect: "manual" })).status, 302);
  await assert.rejects(() => httpFetch(a.base + "/same", { ...any, redirect: "error" }), e => e.code === "redirect_refused");
  const post = await httpFetch(a.base + "/post", { ...any, method: "POST", body: "x" });
  assert.equal(a.hits.at(-1)?.method, "GET", "a 303 turns a POST into a GET");
  assert.equal(post.status, 200);
});

test("retries: a GET again on a 503 and a reset, a POST never on its own, an idempotent POST when told", async t => {
  let n = 0;
  const s = await server((req, res) => {
    if (req.url === "/flaky") { n++; if (n < 3) { res.writeHead(503, { "retry-after": "0" }); res.end(); } else { res.writeHead(200); res.end("up"); } }
    else if (req.url === "/reset") { n++; if (n < 2) req.socket.destroy(); else { res.writeHead(200); res.end("up"); } }
    else { res.writeHead(500); res.end("no"); }
  });
  t.after(s.close);
  assert.equal(await (await httpFetch(s.base + "/flaky", any)).text(), "up");
  assert.equal(n, 3);
  n = 0;
  assert.equal(await (await httpFetch(s.base + "/reset", any)).text(), "up");
  s.hits.length = 0;
  const p = await httpFetch(s.base + "/always", { ...any, method: "POST", body: "x" });
  assert.equal(p.status, 500); assert.equal(s.hits.length, 1, "a POST is sent once");
  s.hits.length = 0;
  await httpFetch(s.base + "/always", { ...any, method: "POST", body: "x", idempotent: true });
  assert.equal(s.hits.length, 3, "an idempotent POST is retried");
});

test("a test's own globalThis.fetch stand-in is honoured, under the same URL and size rules", async () => {
  const real = globalThis.fetch;
  try {
    /** @type {string[]} */ const seen = [];
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => { seen.push(url); return new Response("stand-in", { status: 200 }); });
    assert.equal(await (await httpFetch("https://api.example.com/v1")).text(), "stand-in");
    assert.deepEqual(seen, ["https://api.example.com/v1"]);
    await assert.rejects(() => httpFetch("http://api.example.com/v1"), /only https/);
    globalThis.fetch = /** @type {any} */ (async () => new Response(Buffer.alloc(100)));
    await assert.rejects(() => httpFetch("https://api.example.com/v1", { maxBytes: 10 }), e => e.code === "too_large");
    const f = guardedFetch({ maxBytes: 10 });
    await assert.rejects(() => f("https://api.example.com/v1"), e => e.code === "too_large");
  } finally { globalThis.fetch = real; }
});

test("allow: auto lets this machine through and holds every other address to the public rule; allowFor and userHostFetch are the same idea", async t => {
  const s = await server((req, res) => { res.writeHead(200); res.end("local"); });
  t.after(s.close);
  assert.equal(await (await httpFetch(`${s.base}/`, { allow: "auto", retries: 0 })).text(), "local", "loopback over http");
  await assert.rejects(() => httpFetch("https://10.0.0.5/", { allow: "auto" }), e => e.code === "not_public");
  await assert.rejects(() => httpFetch("http://example.com/", { allow: "auto" }), e => e.code === "not_https");
  assert.equal(allowFor("http://127.0.0.1:7300/x"), "any");
  assert.equal(allowFor("https://api.github.com/x"), "public");
  assert.equal(allowFor("nonsense"), "public");
  assert.equal(await (await userHostFetch(`${s.base}/`, { retries: 0 })).text(), "local");
  assert.equal(await (await autoFetch(`${s.base}/`, { retries: 0 })).text(), "local");
});

test("a stand-in that answers with a plain object is handed back untouched, with the caller's own headers and body", async () => {
  const real = globalThis.fetch;
  try {
    /** @type {any} */ let seen;
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ fake: true }) }; });
    const r = await httpFetch("https://api.example.com/v1", { method: "POST", headers: { authorization: "Bearer t" }, body: '{"a":1}' });
    assert.deepEqual(await r.json(), { fake: true });
    assert.equal(seen.init.headers.authorization, "Bearer t", "the headers the caller wrote, as written");
    assert.equal(seen.init.body, '{"a":1}');
  } finally { globalThis.fetch = real; }
});
