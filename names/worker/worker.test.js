// @ts-check
// The name directory against a fake Workers runtime (relay/worker/fake-cf.js) and a fake Cloudflare
// DNS API (fake-dns.js): a server serving a space's name (point, publish, ACME), the names an older setup gave a server, and the request checks.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "./fake-dns.js";
import * as wire from "../../core/relay/wire.js";
import * as rules from "../../core/names/rules.js";
import { serve } from "./testing.js";

const BASE = "https://names.test";
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** A new directory over fakes. `clock.t` is the directory's now. */
function world(t, env = {}) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 8, 30, 12, 0, 0) };
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", CLAIMS_PER_IP_PER_DAY: "100", ...env } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  return { rt, dns, clock, env: rt.env };
}

/** A box: a route key, and a way to send signed requests. */
function boxOf(w, key = wire.newRouteKey()) {
  const route = wire.routeId(key.pub);
  const send = async (method, path, body, o = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const nonce = o.nonce || crypto.randomBytes(16).toString("base64url");
    const ts = o.ts ?? w.clock.t;
    const bodyHash = crypto.createHash("sha256").update(text).digest("hex");
    const message = W.authMessage({ route, ts, nonce, method, target: path, bodyHash });
    const sig = o.sig || wire.signRoute(key.priv, Buffer.from(message)).toString("base64url");
    const headers = { ...(o.unsigned ? {} : { "x-vyre-route": route, "x-vyre-pub": key.pub.toString("base64url"), "x-vyre-ts": String(ts), "x-vyre-nonce": nonce, "x-vyre-sig": sig }),
      ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": o.ip || "203.0.113.7", ...(o.headers || {}) };
    const res = await worker.fetch(new Request(BASE + path, { method, headers, body: text || undefined }), w.env);
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };
  return { key, route, send, post: (p, b, o) => send("POST", p, b, o), get: (p, o) => send("GET", p, undefined, o), del: (p, b, o) => send("DELETE", p, b, o) };
}
/** A space named `name` that this box serves: the person, the space, and the space's signed note that the box's route is its server. */
const sv = async (w, box, name) => { const x = await serve(w, box, name); data(await x.addServer()); return x; };
/** A name an older setup gave a server, as the directory still holds it until support moves it: the record and the route's index. */
const legacy = (w, box, name, over = {}) => {
  const map = w.rt.object("v1", "DIRECTORY").ctx.storage.map;
  map.set(`n/${name}`, { name, route: box.route, state: "claimed", claimedAt: w.clock.t, everPointed: false, pointedAt: null, ips: {}, notices: [], log: [], ...over });
  map.set(`r/${box.route}`, name);
};
const data = r => { assert.ok(r.json && r.json.data, JSON.stringify(r.json)); return r.json.data; };
const code = r => r.json && r.json.error && r.json.error.code;
const TOKEN = "x".repeat(43);

test("the repeated rules and constants equal core/names/rules.js and core/relay/wire.js", async () => {
  assert.deepEqual([...W.RESERVED].sort(), [...rules.RESERVED].sort());
  assert.deepEqual([...W.BRANDS].sort(), [...rules.BRANDS].sort());
  for (const n of ["alex", "al", "rnicrosoft", "g00gle", "paypa1", "xn--abc", "-abc", "abc-", "a--b", "login-alex", "vyre-fan", "Alex", "team", "my-bank-2"]) assert.deepEqual(rules.verdict(n), W.verdict(n), n);
  for (const ip of ["100.64.0.1", "100.128.0.1", "fd7a:115c:a1e0::1", "::ffff:100.64.0.1", "10.0.0.1", "fd7a:115c:a1e1::1"]) assert.deepEqual(rules.tailnetIp(ip), W.tailnetIp(ip), ip);
  assert.equal(W.AUTH_TAG, "vyre-names-v1");
  const key = wire.newRouteKey();
  assert.equal(await W.routeId(key.pub), wire.routeId(key.pub));
  assert.equal(await W.routeHash(wire.routeId(key.pub)), rules.routeHash(wire.routeId(key.pub)));
});

test("names: reserved, lookalikes, format", () => {
  const status = n => W.verdict(n).status;
  for (const n of ["vyre", "relay", "setup", "phone", "app", "api", "acme", "names", "www", "mail", "team", "login", "account", "secure", "support", "billing", "google", "paypal", "capsule", "glass", "tailnet"]) assert.equal(status(n), "reserved", n);
  // lookalikes fold before the check
  for (const n of ["rnail", "g00gle", "paypa1", "arnazon", "log1n", "supp0rt", "acc0unt", "goog1e"]) assert.equal(status(n), "reserved", n);
  assert.equal(status("my-paypal"), "reserved");
  for (const n of ["ab", "a", "", "xn--nxasmq6b", "-alex", "alex-", "a--b", "1alex", "al ex", "alex.x", "a".repeat(33)]) assert.equal(status(n), "invalid", JSON.stringify(n));
  for (const n of ["alex", "sam-and-co", "kitty", "kitchen", "bob2"]) assert.equal(status(n), "ok", n);
});

test("tailnet addresses only", () => {
  const ok = ["100.64.0.0", "100.101.1.2", "100.127.255.255"];
  for (const ip of ok) assert.deepEqual(W.tailnetIp(ip), { type: "A", ip });
  assert.deepEqual(W.tailnetIp("fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0"), { type: "AAAA", ip: "fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0" });
  assert.deepEqual(W.tailnetIp("FD7A:115C:A1E0:0:0:0:0:1"), { type: "AAAA", ip: "fd7a:115c:a1e0::1" });
  const refuse = ["100.63.255.255", "100.128.0.0", "10.0.0.1", "192.168.1.1", "172.16.0.1", "127.0.0.1", "8.8.8.8", "169.254.1.1", "0.0.0.0", "100.64.0", "100.64.0.1.1", "100.064.0.1", "100.64.0.256", "100.64.0.1 ",
    "::ffff:100.64.0.1", "::ffff:6440:1", "::1", "::", "fe80::1", "fd7a:115c:a1e1::1", "fd7a:115c::1", "fd7a:115c:a1e0", "fd7a:115c:a1e0::1%eth0", "fd7a:115c:a1e0:1:2:3:4:5:6", "fd7a:115c:a1e0::1::2", "2001:db8::1", "fd00::1", "", "example.com", "1e2.0.0.1"];
  for (const ip of refuse) assert.equal(W.tailnetIp(ip), null, JSON.stringify(ip));
});

test("check: ok, taken, reserved, invalid; no signature needed", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  assert.equal(data(await a.get("/v1/names/check?name=alex", { unsigned: true })).status, "ok");
  assert.equal(data(await a.get("/v1/names/check?name=vyre", { unsigned: true })).status, "reserved");
  assert.equal(data(await a.get("/v1/names/check?name=x", { unsigned: true })).status, "invalid");
  await sv(w, a, "alex");
  assert.equal(data(await b.get("/v1/names/check?name=alex")).status, "taken");
  assert.equal(data(await b.get("/v1/names/check?name=alex", { unsigned: true })).status, "taken");
  assert.equal(data(await a.get("/v1/names/check?name=alex")).status, "taken", "a server holds no name: even the one that serves it is told it is a space's");
  // a signed check with a bad signature is refused, not silently anonymous
  assert.equal((await a.get("/v1/names/check?name=alex", { sig: "AAAA" })).status, 401);
});

test("point: a tailnet A record, never an AAAA, and never anything else", async t => {
  const w = world(t), a = boxOf(w);
  await sv(w, a, "alex");
  const p = data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }));
  assert.deepEqual([p.type, p.ip, p.fqdn], ["A", "100.101.1.2", "alex.vyre.run"]);
  const rec = w.dns.at("alex.vyre.run", "A");
  assert.equal(rec.length, 1);
  assert.deepEqual([rec[0].content, rec[0].proxied, rec[0].ttl], ["100.101.1.2", false, 60]);
  // a new address updates the one record
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.9" }));
  assert.deepEqual(w.dns.at("alex.vyre.run", "A").map(r => r.content), ["100.101.1.9"]);
  // A name pointed before this rule still carries an AAAA: pointing it again removes it.
  w.dns.records.push({ id: "old6", type: "AAAA", name: "alex.vyre.run", content: "fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0", ttl: 60, proxied: false });
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.9" }));
  assert.equal(w.dns.at("alex.vyre.run", "AAAA").length, 0, "the stale AAAA is cleared by the next point");
  // The tailnet's IPv6 address is refused: a resolver that filters rebinds drops it (T2b), and IPv4 always works.
  assert.equal(code(await a.post("/v1/names/point", { name: "alex", ip: "fd7a:115c:a1e0:ab12:4843:cd96:6265:f9d0" })), "ipv4_only");
  assert.equal(w.dns.at("alex.vyre.run", "AAAA").length, 0);
  const before = w.dns.records.length;
  for (const ip of ["8.8.8.8", "10.0.0.5", "192.168.1.1", "100.128.0.1", "::ffff:100.64.0.1", "127.0.0.1", "fd00::1", "", 5, null, "100.64.0.1/32"]) {
    const r = await a.post("/v1/names/point", { name: "alex", ip });
    assert.equal(code(r), "not_tailnet", JSON.stringify(ip));
  }
  assert.equal(w.dns.records.length, before);
  assert.equal(data(await a.get("/v1/names/mine")).state, "live");
});

test("point: only the owner, never a name nobody holds, and a DNS failure changes nothing", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  await sv(w, a, "alex");
  assert.equal(code(await b.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" })), "not_yours");
  assert.equal(code(await a.post("/v1/names/point", { name: "nobody", ip: "100.101.1.2" })), "not_yours");
  assert.equal(w.dns.records.length, 0);
  w.dns.state.failNext = 1;
  const r = await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes(w.dns.token));
  assert.equal(data(await a.get("/v1/names/mine")).pointed, false, "state did not move");
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }));
});

test("acme: TXT only for a name the route owns; 10 a day; clear", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  await sv(w, a, "alex");
  assert.equal(code(await b.post("/v1/names/acme", { name: "alex", token: TOKEN })), "not_yours");
  assert.equal(code(await a.post("/v1/names/acme", { name: "other", token: TOKEN })), "not_yours");
  assert.equal(code(await a.post("/v1/names/acme", { name: "alex", token: "short" })), "bad_token");
  assert.equal(code(await a.post("/v1/names/acme", { name: "alex", token: "has space " + "x".repeat(30) })), "bad_token");
  const r = data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  assert.equal(r.fqdn, "_acme-challenge.alex.vyre.run");
  assert.deepEqual(w.dns.at(r.fqdn, "TXT").map(x => x.content), [`"${TOKEN}"`]);
  data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  assert.equal(w.dns.at(r.fqdn, "TXT").length, 1, "the same value is not written twice");
  assert.equal(code(await b.del("/v1/names/acme", { name: "alex" })), "not_yours");
  assert.equal(w.dns.at(r.fqdn, "TXT").length, 1);
  data(await a.del("/v1/names/acme", { name: "alex" }));
  assert.equal(w.dns.at(r.fqdn, "TXT").length, 0);
  // the two writes above and eight more make ten (the repeat counts)
  for (let i = 0; i < 8; i++) data(await a.post("/v1/names/acme", { name: "alex", token: String(i).repeat(43) }));
  assert.equal((await a.post("/v1/names/acme", { name: "alex", token: TOKEN })).status, 429);
  assert.ok(w.dns.at(r.fqdn, "TXT").length <= 4, "a label holds at most four");
  w.clock.t += DAY;
  data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
});

test("acme for the person's own domain writes only under <routehash>.acme.vyre.run", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  assert.equal(code(await b.post("/v1/names/acme", { own: true, token: TOKEN })), "not_yours", "a route with no name has no zone");
  await sv(w, a, "alex");
  const r = data(await a.post("/v1/names/acme", { own: true, token: TOKEN, name: "victim" }));
  assert.equal(r.fqdn, `${await W.routeHash(a.route)}.acme.vyre.run`);
  assert.equal(w.dns.records.length, 1);
  assert.equal(w.dns.records[0].name, r.fqdn);
  assert.equal(w.dns.records[0].type, "TXT");
  assert.equal(data(await a.get("/v1/names/mine")).acmeZone, r.fqdn);
  data(await a.del("/v1/names/acme", { own: true }));
  assert.equal(w.dns.records.length, 0);
});

test("the directory only ever touches A, AAAA and TXT inside its own zone", async t => {
  const w = world(t, { ZONE: "vyre.run" }), a = boxOf(w);
  await sv(w, a, "alex");
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }));
  data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  for (const c of w.dns.calls) assert.ok(!/CNAME|MX|NS/.test(c.path + JSON.stringify(c.body)), c.path);
  for (const r of w.dns.records) assert.ok(r.name.endsWith(".vyre.run"));
  // a name in the store cannot reach outside the zone either
  assert.equal(w.dns.calls.filter(c => c.method === "POST").every(c => c.body.name.endsWith(".vyre.run")), true);
});

test("request checks: a foreign Origin, cross-site, content type, size, methods, cookies", async t => {
  const w = world(t), a = boxOf(w);
  const claim = (headers, body = { name: "alex", ip: "100.101.1.2" }) => a.post("/v1/names/point", body, { headers });
  assert.equal((await claim({ origin: "https://evil.example" })).status, 403);
  assert.equal((await claim({ origin: "https://vyre.run" })).status, 403);
  assert.equal((await claim({ origin: "null" })).status, 403);
  assert.equal((await claim({ origin: "https://names.vyre.run.evil.example" })).status, 403);
  assert.equal((await claim({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await a.del("/v1/names/acme", { own: true }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await a.post("/v1/names/acme", { name: "x", token: TOKEN }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await claim({ "content-type": "text/plain" })).status, 415);
  assert.equal((await claim({ "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal(w.rt.object("v1", "DIRECTORY").ctx.storage.map.size, 0, "nothing was written by any refused request");
  assert.equal((await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2", pad: "x".repeat(5000) })).status, 413);
  const ok = await claim({ origin: "https://names.vyre.run" });
  assert.equal(code(ok), "not_yours", "its own origin is exact-matched: it gets past the Origin check to the ownership one");
  assert.equal((await worker.fetch(new Request(BASE + "/v1/names/point", { method: "PUT" }), w.env)).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + "/nope"), w.env)).status, 404);
  assert.equal((await worker.fetch(new Request(BASE + "/health"), w.env)).status, 200);
  // no cookies, in or out; no CORS; no caching; JSON only
  const res = await a.get("/v1/names/mine", { headers: { cookie: "session=abc" } });
  for (const h of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials"]) assert.equal(res.headers.get(h), null, h);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const opts = await worker.fetch(new Request(BASE + "/v1/names/point", { method: "OPTIONS", headers: { origin: "https://vyre.run" } }), w.env);
  assert.equal(opts.status, 405);
  assert.equal(opts.headers.get("access-control-allow-origin"), null);
});

test("signatures: unsigned, forged, wrong key for the route, stale, replayed and tampered requests are refused", async t => {
  const w = world(t), a = boxOf(w), evil = boxOf(w);
  assert.equal((await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }, { unsigned: true })).status, 401);
  assert.equal((await a.get("/v1/names/mine", { unsigned: true })).status, 401);
  assert.equal((await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }, { sig: crypto.randomBytes(64).toString("base64url") })).status, 401);
  // someone else's key claiming this route id
  const forged = await worker.fetch(new Request(BASE + "/v1/names/mine", { headers: { "x-vyre-route": a.route, "x-vyre-pub": evil.key.pub.toString("base64url"), "x-vyre-ts": String(w.clock.t), "x-vyre-nonce": "n".repeat(20), "x-vyre-sig": "A".repeat(86) } }), w.env);
  assert.equal(forged.status, 401);
  assert.equal((await a.get("/v1/names/mine", { ts: w.clock.t - 120_000 })).status, 401);
  assert.equal((await a.get("/v1/names/mine", { ts: w.clock.t + 120_000 })).status, 401);
  assert.equal((await a.get("/v1/names/mine", { ts: w.clock.t - 30_000 })).status, 200);
  const nonce = "r".repeat(22);
  assert.equal((await a.get("/v1/names/mine", { nonce })).status, 200);
  assert.equal((await a.get("/v1/names/mine", { nonce })).status, 401, "a replay is refused");
  // a signature over one body does not cover another
  const key = a.key, text = JSON.stringify({ name: "alex" });
  const msg = W.authMessage({ route: a.route, ts: w.clock.t, nonce: "t".repeat(22), method: "POST", target: "/v1/names/point", bodyHash: crypto.createHash("sha256").update(text).digest("hex") });
  const sig = wire.signRoute(key.priv, Buffer.from(msg)).toString("base64url");
  const tampered = await worker.fetch(new Request(BASE + "/v1/names/point", { method: "POST", body: JSON.stringify({ name: "mallory" }),
    headers: { "content-type": "application/json", "x-vyre-route": a.route, "x-vyre-pub": key.pub.toString("base64url"), "x-vyre-ts": String(w.clock.t), "x-vyre-nonce": "t".repeat(22), "x-vyre-sig": sig } }), w.env);
  assert.equal(tampered.status, 401);
  // the signature covers the path: a signed check cannot be replayed as a different call
  assert.equal(w.rt.object("v1", "DIRECTORY").ctx.storage.map.has("n/alex"), false);
});

test("publish: the name's A record is the public IPv4 the request came from, and nothing the caller names", async t => {
  const w = world(t), a = boxOf(w);
  await sv(w, a, "pubby");
  const p = data(await a.post("/v1/names/publish", { name: "pubby", ip: "8.8.8.8" }, { ip: "93.184.216.34" }));
  assert.deepEqual([p.type, p.ip, p.fqdn], ["A", "93.184.216.34", "pubby.vyre.run"], "the observed address, not the body's");
  assert.deepEqual(w.dns.at("pubby.vyre.run", "A").map(r => r.content), ["93.184.216.34"]);
  data(await a.post("/v1/names/publish", { name: "pubby" }, { ip: "93.184.216.35" }));
  assert.deepEqual(w.dns.at("pubby.vyre.run", "A").map(r => r.content), ["93.184.216.35"], "a new address updates the one record");
  assert.equal(data(await a.get("/v1/names/mine")).state, "live");
  const before = w.dns.records.length;
  for (const ip of ["10.0.0.5", "192.168.1.1", "100.64.0.9", "127.0.0.1", "169.254.1.1", "172.16.0.1", "203.0.113.7", "224.0.0.1", "unknown"]) {
    assert.equal(code(await a.post("/v1/names/publish", { name: "pubby" }, { ip })), "not_public", ip);
  }
  assert.equal(w.dns.records.length, before);
  const b = boxOf(w);
  assert.notEqual(b.route, a.route);
  assert.ok(code(await b.post("/v1/names/publish", { name: "pubby" }, { ip: "93.184.216.34" })), "another route cannot publish a name it does not hold");
});

const ADMIN = "s".repeat(48);
const adminDrop = (w, body, secret = ADMIN) => worker.fetch(new Request(BASE + "/v1/names/admin/drop", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(secret === null ? {} : { "x-vyre-admin": secret }) }, body: JSON.stringify(body),
}), w.env).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

test("admin drop: a server's name is taken back, its address unpublished, and the name is free to claim again", async t => {
  const w = world(t, { ADMIN_SECRET: ADMIN }), a = boxOf(w);
  legacy(w, a, "alex");
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.1" }));
  assert.equal((await adminDrop(w, { name: "alex" }, null)).status, 401, "no header");
  assert.equal((await adminDrop(w, { name: "alex" }, "w".repeat(48))).status, 401, "a wrong secret");
  const r = await adminDrop(w, { name: "alex" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(w.dns.records.length, 0, "the address is unpublished");
  assert.equal(data(await a.get("/v1/names/mine")).name, null, "the server no longer holds it");
  const n = boxOf(w);
  assert.equal(data(await n.get("/v1/names/check?name=alex")).status, "ok", "free again");
  assert.equal(code(await adminDrop(w, { name: "alex" })), "no_such_name");
});

test("admin drop: an identity's name (its keys lost) is given up with no tombstone and can be claimed again; without the secret it stays", async t => {
  const w = world(t, { ADMIN_SECRET: ADMIN }), a = boxOf(w);
  await serve(w, a, "robin");
  assert.equal(data(await a.get("/v1/names/check?name=robin")).status, "taken");
  assert.equal((await adminDrop(w, { name: "robin" }, "w".repeat(48))).status, 401, "a wrong secret");
  assert.equal(data(await a.get("/v1/names/check?name=robin")).status, "taken", "still held");
  const r = await adminDrop(w, { name: "robin" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.identity, true);
  assert.equal(data(await boxOf(w).get("/v1/names/check?name=robin")).status, "ok", "free to reserve again");
  assert.equal(code(await adminDrop(w, { name: "robin" })), "no_such_name");
});

test("a space's servers: only a route the space listed may point, publish or write a challenge for its name; the space adds and removes them with a signed act", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  const x = await serve(w, a, "harlow");
  // before the space says so, the route serves nothing
  assert.equal(code(await a.post("/v1/names/point", { name: "harlow", ip: "100.101.1.2" })), "not_yours");
  assert.equal(data(await a.get("/v1/names/mine")).name, null);
  // the FIRST server needs no older sign-in (a person upgrading on their first day); a forged act does not pass
  assert.equal(code(await x.space.post("/v1/ids/server", { name: "harlow", route: a.route, act: { ...(await x.signed("server-add", a.route)), sig: "AAAA" } })), "bad_signature");
  assert.equal(code(await x.space.post("/v1/ids/server", { name: "harlow", route: "nope", act: await x.signed("server-add", a.route) })), "bad_route");
  assert.equal(data(await x.addServer()).servers, 1);
  assert.equal(data(await x.addServer()).servers, 1, "adding twice is one");
  assert.equal(data(await a.post("/v1/names/point", { name: "harlow", ip: "100.101.1.2" })).fqdn, "harlow.vyre.run");
  assert.equal(data(await a.post("/v1/names/acme", { name: "harlow", token: TOKEN })).fqdn, "_acme-challenge.harlow.vyre.run");
  const mine = data(await a.get("/v1/names/mine"));
  assert.deepEqual([mine.name, mine.state, mine.pointed], ["harlow", "live", true]);
  // another route is still a stranger, and a person's own name is no space
  assert.equal(code(await b.post("/v1/names/point", { name: "harlow", ip: "100.101.1.2" })), "not_yours");
  assert.equal(code(await a.post("/v1/names/point", { name: x.owner.state.id, ip: "100.101.1.2" })), "not_yours");
  // a second server (the founding device signs; a device added later needs a day of age, as for every change to the space)
  assert.equal(data(await x.addServer(b.route)).servers, 2);
  assert.equal(data(await b.post("/v1/names/publish", { name: "harlow" }, { ip: "93.184.216.34" })).ip, "93.184.216.34");
  // removing the first stops it; the second goes on
  assert.equal(data(await x.removeServer(a.route)).servers, 1);
  assert.equal(code(await a.post("/v1/names/point", { name: "harlow", ip: "100.101.1.2" })), "not_yours");
  assert.equal(data(await a.get("/v1/names/mine")).name, null);
  assert.equal(data(await b.post("/v1/names/point", { name: "harlow", ip: "100.101.1.2" })).ip, "100.101.1.2");
});

test("a space has at most eight servers", async t => {
  const w = world(t), a = boxOf(w);
  const x = await serve(w, a, "harlow");
  data(await x.addServer());
  w.clock.t += 25 * HOUR;
  for (let i = 0; i < 7; i++) data(await x.addServer(boxOf(w).route));
  assert.equal(code(await x.addServer(boxOf(w).route)), "too_many_servers");
});
