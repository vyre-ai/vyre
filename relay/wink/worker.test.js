// @ts-check
// relay/wink/worker.js: every response carries the page's headers, /release/ and unknown methods are refused, a missing file is a 404
// (never the page), and nothing sets a cookie. A fake ASSETS binding; no network.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { HEADERS } from "./headers.js";

const files = { "/": ["<!doctype html>", 200], "/index.html": ["<!doctype html>", 200], "/sw.js": ["//sw", 200], "/relay/wink/wink.js": ["//wink", 200] };
const env = { ASSETS: { fetch: async req => { const f = files[new URL(req.url).pathname]; return f ? new Response(f[0], { status: f[1], headers: { "set-cookie": "a=b", "content-type": "text/html" } }) : new Response("nope", { status: 404 }); } } };
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
