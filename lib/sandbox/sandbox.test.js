import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isPublicAddress, mediatedFetch, FetchRefused, sandboxIdentity } from "./index.js";

test("public addresses pass, everything internal is refused", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.100",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd7a:115c:a1e0::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1", "2001:0:4136:e378::1", "not-an-ip", "", "1.2.3"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("172.32.0.1"), true);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
});

/** A fake transport: responses keyed by path; records where each connection went. */
function fake(routes) {
  const calls = [];
  const request = (mod, o, cb) => {
    calls.push(o);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => {
      const r = routes[o.path] || { status: 404, body: "" };
      const res = new EventEmitter(); res.statusCode = r.status; res.headers = r.headers || {}; res.destroy = () => res.emit("close");
      cb(res);
      queueMicrotask(() => { if (r.body) res.emit("data", Buffer.from(r.body)); res.emit("end"); });
    };
    return req;
  };
  return { request, calls };
}
const lookup = map => async h => map[h] || [];

test("fetch connects to the checked address and sends the real host", async () => {
  const f = fake({ "/a": { status: 200, body: "hi", headers: { "Content-Type": "text/plain" } } });
  const r = await mediatedFetch("https://news.example/a", {}, { lookup: lookup({ "news.example": ["93.184.216.34"] }), request: f.request });
  assert.equal(r.body, "hi"); assert.equal(r.headers["content-type"], "text/plain");
  const dialed = await new Promise(res => f.calls[0].lookup("news.example", {}, (e, a) => res(a)));
  assert.equal(dialed, "93.184.216.34"); assert.equal(f.calls[0].servername, "news.example"); assert.equal(f.calls[0].hostname, "news.example");
});

test("refuses writes, odd schemes, odd ports and URL credentials", async () => {
  const o = { lookup: lookup({ "a.example": ["93.184.216.34"] }), request: fake({}).request };
  await assert.rejects(mediatedFetch("https://a.example/", { method: "POST" }, o), /GET and HEAD/);
  await assert.rejects(mediatedFetch("ftp://a.example/", {}, o), /http and https only/);
  await assert.rejects(mediatedFetch("https://a.example:8443/", {}, o), /port 8443/);
  await assert.rejects(mediatedFetch("https://u:p@a.example/", {}, o), /credentials come from the vault/);
});

test("a name that resolves to any private address is refused, even with a public one beside it", async () => {
  const f = fake({});
  const o = { lookup: lookup({ "evil.example": ["93.184.216.34", "10.0.0.5"], "meta.example": ["169.254.169.254"] }), request: f.request };
  await assert.rejects(mediatedFetch("https://evil.example/", {}, o), /10\.0\.0\.5/);
  await assert.rejects(mediatedFetch("http://meta.example/latest", {}, o), FetchRefused);
  await assert.rejects(mediatedFetch("http://127.0.0.1/", {}, o), /not a public address/);
  await assert.rejects(mediatedFetch("http://[::1]/", {}, o), /not a public address/);
  assert.equal(f.calls.length, 0);
});

test("a redirect to a private address is refused; a public one is followed and rechecked", async () => {
  const f = fake({ "/go": { status: 302, headers: { location: "http://inside.example/x" } }, "/ok": { status: 302, headers: { location: "https://b.example/done" } }, "/done": { status: 200, body: "fin" } });
  const l = lookup({ "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"], "inside.example": ["192.168.0.9"] });
  await assert.rejects(mediatedFetch("https://a.example/go", {}, { lookup: l, request: f.request }), /192\.168\.0\.9/);
  const r = await mediatedFetch("https://a.example/ok", {}, { lookup: l, request: f.request });
  assert.equal(r.body, "fin"); assert.equal(r.url, "https://b.example/done");
});

test("a redirect loop stops", async () => {
  const f = fake({ "/l": { status: 302, headers: { location: "/l" } } });
  await assert.rejects(mediatedFetch("https://a.example/l", {}, { lookup: lookup({ "a.example": ["93.184.216.34"] }), request: f.request }), /redirects/);
});

test("the parent's credential goes to its own host only, and never survives a redirect away", async () => {
  const f = fake({ "/s": { status: 302, headers: { location: "https://other.example/t" } }, "/t": { status: 200, body: "ok" } });
  const l = lookup({ "api.example": ["93.184.216.34"], "other.example": ["93.184.216.36"] });
  await mediatedFetch("https://api.example/s", { headers: { Authorization: "Bearer child-forged" } }, { lookup: l, request: f.request, auth: { host: "api.example", header: "Authorization", value: "Bearer real" } });
  assert.equal(f.calls[0].headers.authorization, "Bearer real");      // the child's own header is dropped, the parent's attached
  assert.equal(f.calls[1].headers.authorization, undefined);          // not sent to the redirect target
  const g = fake({ "/t": { status: 200, body: "ok" } });
  await mediatedFetch("https://other.example/t", {}, { lookup: l, request: g.request, auth: { host: "api.example", header: "Authorization", value: "Bearer real" } });
  assert.equal(g.calls[0].headers.authorization, undefined);
});

test("a body past the cap is cut and flagged", async () => {
  const f = fake({ "/big": { status: 200, body: "x".repeat(500) } });
  const r = await mediatedFetch("https://a.example/big", {}, { lookup: lookup({ "a.example": ["93.184.216.34"] }), request: f.request, maxBytes: 100 });
  assert.equal(r.body.length, 100); assert.equal(r.truncated, true);
});

test("sandbox identity: not root means no isolation, root with the user means a uid", () => {
  assert.equal(sandboxIdentity({ getuid: () => 501 }).isolated, false);
  assert.equal(sandboxIdentity({ getuid: () => 0, env: {}, lookup: () => null }).isolated, false);
  const i = sandboxIdentity({ getuid: () => 0, env: {}, lookup: n => (n === "vyre-sandbox" ? 998 : null) });
  assert.deepEqual([i.isolated, i.uid], [true, 998]);
  assert.equal(sandboxIdentity({ getuid: () => 0, env: { VYRE_SANDBOX_UID: "0" }, lookup: () => null }).isolated, false);
});

test("a redirect may not leave the declared hosts, even to a public address", async () => {
  const f = fake({ "/redir": { status: 302, headers: { location: "https://evil.example/?d=DATA" } } });
  const l = lookup({ "api.example": ["93.184.216.34"], "evil.example": ["93.184.216.40"] });
  const allowHost = u => u.hostname === "api.example";
  await assert.rejects(mediatedFetch("https://api.example/redir", {}, { lookup: l, request: f.request, allowHost }), /declared hosts/);
  assert.equal(f.calls.length, 1, "nothing was sent to the other host");
  await assert.rejects(mediatedFetch("https://evil.example/", {}, { lookup: l, request: f.request, allowHost }), /declared hosts/);
});

test("the credential goes over https only, and is dropped when a redirect changes scheme", async () => {
  const f = fake({ "/a": { status: 302, headers: { location: "http://api.example/b" } }, "/b": { status: 200, body: "ok" } });
  const l = lookup({ "api.example": ["93.184.216.34"] });
  const auth = { host: "api.example", header: "Authorization", value: "Bearer real" };
  await mediatedFetch("https://api.example/a", {}, { lookup: l, request: f.request, auth });
  assert.equal(f.calls[0].headers.authorization, "Bearer real");
  assert.equal(f.calls[1].headers.authorization, undefined, "sent in clear after https to http");
  const g = fake({ "/b": { status: 200, body: "ok" } });
  await mediatedFetch("http://api.example/b", {}, { lookup: l, request: g.request, auth });
  assert.equal(g.calls[0].headers.authorization, undefined, "attached to a plain http request");
});

test("a slow response is cut at one overall deadline", async () => {
  const request = (mod, o, cb) => {
    const req = new EventEmitter(); req.destroy = e => req.emit("error", e); req.end = () => {};
    o.signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })));
    return req;   // never answers
  };
  await assert.rejects(mediatedFetch("https://a.example/", {}, { lookup: lookup({ "a.example": ["93.184.216.34"] }), request, timeoutMs: 30 }), /took longer/);
});

test("the old 6to4 relay anycast and site-local ranges are refused", () => {
  for (const ip of ["192.88.99.1", "fec0::1", "feff::1"]) assert.equal(isPublicAddress(ip), false, ip);
});
