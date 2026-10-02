// @ts-check
// relay/wink/worker.js: every response carries the page's headers, /release/ and unknown methods are refused, a missing file is a 404
// (never the page), and nothing sets a cookie. A fake ASSETS binding; no network.

import test from "node:test";
import assert from "node:assert/strict";
import worker, { plainPath } from "./worker.js";
import { HEADERS } from "./headers.js";

const files = { "/index.html": ["<!doctype html>", 200], "/sw.js": ["//sw", 200], "/relay/wink/wink.js": ["//wink", 200], "/old": ["", 301], "/see": ["", 302], "/same": [null, 304], "/multi": ["", 300], "/perm": ["", 308], "/use": ["", 305] };
const env = { ASSETS: { fetch: async req => { const f = files[new URL(req.url).pathname]; return f ? new Response(f[0], { status: f[1], headers: { "set-cookie": "a=b", "content-type": "text/html" } }) : new Response("nope", { status: 404 }); } } };
// A plain object stands in for the request so the URL parser does not tidy the path before the Worker sees it.
const raw = (p, method = "GET") => worker.fetch(/** @type {any} */ ({ url: `https://wink.vyre.run${p}`, method, headers: new Headers() }), env);
const get = (p, method = "GET") => worker.fetch(new Request(`https://wink.vyre.run${p}`, { method }), env);

test("wink worker: every response, found or not, carries the page's headers and no cookie", async () => {
  for (const [p, status] of [["/", 200], ["/sw.js", 200], ["/relay/wink/wink.js", 200], ["/missing", 404], ["/release/x", 404]]) {
    const r = await get(p);
    assert.equal(r.status, status, p);
    for (const [k, v] of Object.entries(HEADERS)) assert.equal(r.headers.get(k), v, `${p} ${k}`);
    assert.equal(r.headers.get("cache-control"), "no-cache", p);
    assert.equal(r.headers.get("set-cookie"), null, `${p} sets no cookie`);
  }
  assert.match(String(HEADERS["content-security-policy"]), /frame-ancestors 'none'/);
});

test("wink worker: only GET and HEAD, /release/ is never served, and a missing file is not the page", async () => {
  for (const m of ["POST", "PUT", "DELETE"]) { const r = await get("/", m); assert.equal(r.status, 405); assert.equal(r.headers.get("x-frame-options"), "DENY"); }
  assert.equal((await get("/", "HEAD")).status, 200);
  const miss = await get("/pair");
  assert.equal(miss.status, 404);
  assert.notEqual(await miss.text(), "<!doctype html>", "an unknown path is a 404, not index.html");
});

test("wink worker: the page's one route is mapped to index.html by the Worker, since the assets binding does no HTML handling", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "<!doctype html>");
  assert.equal((await get("/index.html")).status, 200);
});

test("wink worker: //, backslashes, encoded slashes and dots, and dot segments are a 404 and never reach the assets", async () => {
  let reached = 0;
  const spy = { ASSETS: { fetch: async () => { reached++; return new Response("x"); } } };
  for (const p of ["//", "//sw.js", "/a//b", "/a\\b", "/%2f", "/a%2Fb", "/a%5cb", "/A%5Cb", "/%2e%2e/sw.js", "/a/%2E/b", "/.", "/..", "/a/../b", "/./sw.js", "/relay/wink/../../x", "/a%00b"]) {
    const r = await worker.fetch(/** @type {any} */ ({ url: `https://wink.vyre.run${p}`, method: "GET", headers: new Headers() }), spy);
    assert.equal(r.status, 404, p);
    for (const [k, v] of Object.entries(HEADERS)) assert.equal(r.headers.get(k), v, `${p} ${k}`);
  }
  assert.equal(reached, 0, "none of them reached the assets binding");
  assert.equal(plainPath("https://wink.vyre.run/relay/wink/wink.js?x=//#//"), "/relay/wink/wink.js", "the query and fragment are not the path");
  assert.equal((await raw("/sw.js")).status, 200);
});

test("wink worker: a redirect from the assets binding is a 404, a 304 is passed on as a cache hit", async () => {
  assert.equal((await get("/old")).status, 404);
  assert.equal((await get("/see")).status, 404);
  for (const p of ["/multi", "/perm", "/use"]) assert.equal((await get(p)).status, 404, `${p}: any 3xx but 304`);
  assert.equal((await get("/same")).status, 304);
});
