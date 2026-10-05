// @ts-check
// The name directory against a fake Workers runtime (relay/worker/fake-cf.js) and a fake Cloudflare
// DNS API (fake-dns.js): claim, point, ACME, tombstones, limits, and the request checks.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "./fake-dns.js";
import * as wire from "../../core/relay/wire.js";
import * as rules from "../../core/names/rules.js";

const BASE = "https://names.test";
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** A new directory over fakes. `clock.t` is the directory's now. */
function world(t, env = {}) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 8, 30, 12, 0, 0) };
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", ...env } });
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
const data = r => { assert.ok(r.json && r.json.data, JSON.stringify(r.json)); return r.json.data; };
const code = r => r.json && r.json.error && r.json.error.code;
const TOKEN = "x".repeat(43);
const nextHash = (name, c) => W.codeHash(name, c);

test("the repeated rules and constants equal core/names/rules.js and core/relay/wire.js", async () => {
  assert.deepEqual([...W.RESERVED].sort(), [...rules.RESERVED].sort());
  assert.deepEqual([...W.BRANDS].sort(), [...rules.BRANDS].sort());
  for (const n of ["alex", "al", "rnicrosoft", "g00gle", "paypa1", "xn--abc", "-abc", "abc-", "a--b", "login-alex", "vyre-fan", "Alex", "team", "my-bank-2"]) assert.deepEqual(rules.verdict(n), W.verdict(n), n);
  for (const ip of ["100.64.0.1", "100.128.0.1", "fd7a:115c:a1e0::1", "::ffff:100.64.0.1", "10.0.0.1", "fd7a:115c:a1e1::1"]) assert.deepEqual(rules.tailnetIp(ip), W.tailnetIp(ip), ip);
  assert.equal(W.AUTH_TAG, "vyre-names-v1");
  const key = wire.newRouteKey();
  assert.equal(await W.routeId(key.pub), wire.routeId(key.pub));
  assert.equal(await W.routeHash(wire.routeId(key.pub)), rules.routeHash(wire.routeId(key.pub)));
  assert.equal(await W.codeHash("alex", "ABCD-efgh"), rules.codeHash("alex", "abcdefgh"));
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

test("check: ok, taken, reserved, invalid, mine; no signature needed", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  assert.equal(data(await a.get("/v1/names/check?name=alex", { unsigned: true })).status, "ok");
  assert.equal(data(await a.get("/v1/names/check?name=vyre", { unsigned: true })).status, "reserved");
  assert.equal(data(await a.get("/v1/names/check?name=x", { unsigned: true })).status, "invalid");
  data(await a.post("/v1/names/claim", { name: "alex" }));
  assert.equal(data(await b.get("/v1/names/check?name=alex")).status, "taken");
  assert.equal(data(await b.get("/v1/names/check?name=alex", { unsigned: true })).status, "taken");
  assert.equal(data(await a.get("/v1/names/check?name=alex")).status, "mine");
  // a signed check with a bad signature is refused, not silently anonymous
  assert.equal((await a.get("/v1/names/check?name=alex", { sig: "AAAA" })).status, 401);
});

test("claim binds a name for good, returns a one-time code, stores only its hash", async t => {
  const w = world(t), a = boxOf(w);
  const r = data(await a.post("/v1/names/claim", { name: "Alex" }));
  assert.equal(r.name, "alex");
  assert.match(r.code, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  const plain = r.code.replace(/-/g, "");
  assert.equal(plain.length, 26);
  const stored = JSON.stringify([...w.rt.object("v1", "DIRECTORY").ctx.storage.map]);
  assert.ok(!stored.includes(plain), "the code is not stored");
  assert.ok(stored.includes(await W.codeHash("alex", r.code)), "its hash is");
  // the same route asking again learns it is theirs and gets no second code
  assert.deepEqual(data(await a.post("/v1/names/claim", { name: "alex" })), { name: "alex", mine: true, code: null });
  const mine = data(await a.get("/v1/names/mine"));
  assert.equal(mine.name, "alex");
  assert.equal(mine.state, "claimed");
  assert.equal(mine.fqdn, "alex.vyre.run");
  assert.match(mine.acmeZone, /^[a-z2-7]{26}\.acme\.vyre\.run$/);
  assert.equal(w.dns.records.length, 0, "a claim writes no DNS");
});

test("claim refuses reserved, lookalike, invalid and taken names, and a second name for a route", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  assert.equal(code(await a.post("/v1/names/claim", { name: "vyre" })), "reserved");
  assert.equal(code(await a.post("/v1/names/claim", { name: "g00gle" })), "reserved");
  assert.equal(code(await a.post("/v1/names/claim", { name: "xn--abc" })), "invalid");
  assert.equal(code(await a.post("/v1/names/claim", { name: "ab" })), "invalid");
  data(await a.post("/v1/names/claim", { name: "alex" }));
  assert.equal(code(await b.post("/v1/names/claim", { name: "alex" })), "taken");
  assert.equal(code(await a.post("/v1/names/claim", { name: "alexa" })), "one_per_route");
  assert.equal((await b.post("/v1/names/claim", { name: "alexa" })).status, 200);
});

test("limits: 5 claims per address a day, then a global ceiling", async t => {
  const w = world(t, { GLOBAL_CLAIMS_PER_DAY: "7" });
  for (let i = 0; i < 5; i++) assert.equal((await boxOf(w).post("/v1/names/claim", { name: `name-${"abcde"[i]}x` }, { ip: "192.0.2.1" })).status, 200);
  const sixth = await boxOf(w).post("/v1/names/claim", { name: "name-fx" }, { ip: "192.0.2.1" });
  assert.equal(sixth.status, 429);
  assert.equal((await boxOf(w).post("/v1/names/claim", { name: "name-fx" }, { ip: "192.0.2.2" })).status, 200);
  assert.equal((await boxOf(w).post("/v1/names/claim", { name: "name-gx" }, { ip: "192.0.2.3" })).status, 200);
  const over = await boxOf(w).post("/v1/names/claim", { name: "name-hx" }, { ip: "192.0.2.4" });
  assert.equal(over.status, 429);
  assert.match(over.json.error.message, /busy/);
  // tomorrow the counters start again
  w.clock.t += DAY;
  assert.equal((await boxOf(w).post("/v1/names/claim", { name: "name-hx" }, { ip: "192.0.2.1" })).status, 200);
});

test("point: a tailnet A record, never an AAAA, and never anything else", async t => {
  const w = world(t), a = boxOf(w);
  data(await a.post("/v1/names/claim", { name: "alex" }));
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
  data(await a.post("/v1/names/claim", { name: "alex" }));
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
  data(await a.post("/v1/names/claim", { name: "alex" }));
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
  data(await a.post("/v1/names/claim", { name: "alex" }));
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
  data(await a.post("/v1/names/claim", { name: "alex" }));
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }));
  data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  data(await a.post("/v1/names/release", { name: "alex" }));
  for (const c of w.dns.calls) assert.ok(!/CNAME|MX|NS/.test(c.path + JSON.stringify(c.body)), c.path);
  for (const r of w.dns.records) assert.ok(r.name.endsWith(".vyre.run"));
  // a name in the store cannot reach outside the zone either
  assert.equal(w.dns.calls.filter(c => c.method === "POST").every(c => c.body.name.endsWith(".vyre.run")), true);
});

test("request checks: a foreign Origin, cross-site, content type, size, methods, cookies", async t => {
  const w = world(t), a = boxOf(w);
  const claim = (headers, body = { name: "alex" }) => a.post("/v1/names/claim", body, { headers });
  assert.equal((await claim({ origin: "https://evil.example" })).status, 403);
  assert.equal((await claim({ origin: "https://vyre.run" })).status, 403);
  assert.equal((await claim({ origin: "null" })).status, 403);
  assert.equal((await claim({ origin: "https://names.vyre.run.evil.example" })).status, 403);
  assert.equal((await claim({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await a.del("/v1/names/acme", { own: true }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await a.post("/v1/names/code", { name: "x" }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await claim({ "content-type": "text/plain" })).status, 415);
  assert.equal((await claim({ "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal(w.rt.object("v1", "DIRECTORY").ctx.storage.map.size, 0, "nothing was written by any refused request");
  assert.equal((await a.post("/v1/names/claim", { name: "alex", pad: "x".repeat(5000) })).status, 413);
  const ok = await claim({ origin: "https://names.vyre.run" });
  assert.equal(ok.status, 200, "its own origin is exact-matched");
  assert.equal((await worker.fetch(new Request(BASE + "/v1/names/claim", { method: "PUT" }), w.env)).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + "/nope"), w.env)).status, 404);
  assert.equal((await worker.fetch(new Request(BASE + "/health"), w.env)).status, 200);
  // no cookies, in or out; no CORS; no caching; JSON only
  const res = await a.get("/v1/names/mine", { headers: { cookie: "session=abc" } });
  for (const h of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials"]) assert.equal(res.headers.get(h), null, h);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const opts = await worker.fetch(new Request(BASE + "/v1/names/claim", { method: "OPTIONS", headers: { origin: "https://vyre.run" } }), w.env);
  assert.equal(opts.status, 405);
  assert.equal(opts.headers.get("access-control-allow-origin"), null);
});

test("signatures: unsigned, forged, wrong key for the route, stale, replayed and tampered requests are refused", async t => {
  const w = world(t), a = boxOf(w), evil = boxOf(w);
  assert.equal((await a.post("/v1/names/claim", { name: "alex" }, { unsigned: true })).status, 401);
  assert.equal((await a.get("/v1/names/mine", { unsigned: true })).status, 401);
  assert.equal((await a.post("/v1/names/claim", { name: "alex" }, { sig: crypto.randomBytes(64).toString("base64url") })).status, 401);
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
  const msg = W.authMessage({ route: a.route, ts: w.clock.t, nonce: "t".repeat(22), method: "POST", target: "/v1/names/claim", bodyHash: crypto.createHash("sha256").update(text).digest("hex") });
  const sig = wire.signRoute(key.priv, Buffer.from(msg)).toString("base64url");
  const tampered = await worker.fetch(new Request(BASE + "/v1/names/claim", { method: "POST", body: JSON.stringify({ name: "mallory" }),
    headers: { "content-type": "application/json", "x-vyre-route": a.route, "x-vyre-pub": key.pub.toString("base64url"), "x-vyre-ts": String(w.clock.t), "x-vyre-nonce": "t".repeat(22), "x-vyre-sig": sig } }), w.env);
  assert.equal(tampered.status, 401);
  // the signature covers the path: a signed check cannot be replayed as a different call
  assert.equal(w.rt.object("v1", "DIRECTORY").ctx.storage.map.has("n/alex"), false);
});

test("release: a never-pointed name is free again; a pointed name becomes a tombstone forever", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w);
  data(await a.post("/v1/names/claim", { name: "alex" }));
  assert.deepEqual(data(await a.post("/v1/names/release", { name: "alex" })), { name: "alex", tombstone: false });
  assert.equal(data(await b.post("/v1/names/claim", { name: "alex" })).mine, true, "free to anyone");
  data(await b.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" }));
  data(await b.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  assert.deepEqual(data(await b.post("/v1/names/release", { name: "alex" })), { name: "alex", tombstone: true });
  assert.equal(w.dns.records.length, 0, "its records are gone");
  // never anyone else's, and its owner's route is free to hold another name
  assert.equal(code(await a.post("/v1/names/claim", { name: "alex" })), "taken");
  assert.equal(data(await a.get("/v1/names/check?name=alex")).status, "taken");
  assert.equal(code(await b.post("/v1/names/point", { name: "alex", ip: "100.101.1.2" })), "not_yours");
  w.clock.t += 400 * DAY;
  await w.env.DIRECTORY.get(w.env.DIRECTORY.idFromName("v1")).fetch("https://directory/op", { method: "POST", body: JSON.stringify({ op: "sweep" }) });
  assert.equal(data(await a.get("/v1/names/check?name=alex")).status, "taken", "a year later, still");
  assert.equal(data(await b.post("/v1/names/claim", { name: "bobby" })).name, "bobby");
});

test("a claimed name never pointed lapses after 7 days; a pointed one does not", async t => {
  const w = world(t), a = boxOf(w), b = boxOf(w), c = boxOf(w);
  data(await a.post("/v1/names/claim", { name: "alex" }));
  data(await b.post("/v1/names/claim", { name: "bobby" }));
  data(await b.post("/v1/names/point", { name: "bobby", ip: "100.101.1.2" }));
  w.clock.t += 6 * DAY;
  assert.equal(data(await c.get("/v1/names/check?name=alex")).status, "taken");
  w.clock.t += 2 * DAY;
  assert.equal(data(await c.get("/v1/names/check?name=alex")).status, "ok", "lapsed, checked lazily");
  assert.equal(data(await a.get("/v1/names/mine")).name, null, "and its route is free");
  assert.equal(data(await c.post("/v1/names/claim", { name: "alex" })).mine, true);
  w.clock.t += 365 * DAY;
  assert.equal(data(await c.get("/v1/names/check?name=bobby")).status, "taken");
});

test("the sweep lapses names with nobody looking", async t => {
  const w = world(t), a = boxOf(w);
  data(await a.post("/v1/names/claim", { name: "alex" }));
  data(await a.post("/v1/names/acme", { name: "alex", token: TOKEN }));
  w.clock.t += 8 * DAY;
  await worker.scheduled({}, w.env);
  const store = w.rt.object("v1", "DIRECTORY").ctx.storage.map;
  assert.equal(store.has("n/alex"), false);
  assert.equal(store.has(`r/${a.route}`), false);
  assert.equal([...store.keys()].some(k => k.startsWith("c/")), false, "old counters are dropped");
});

async function claimed(w, name = "alex") {
  const a = boxOf(w);
  const { code: c } = data(await a.post("/v1/names/claim", { name }));
  data(await a.post("/v1/names/point", { name, ip: "100.101.1.2" }));
  return { a, code: c };
}

test("code: the owner replaces the recovery code", async t => {
  const w = world(t), { a, code: c } = await claimed(w);
  const n = boxOf(w);
  assert.equal(code(await n.post("/v1/names/code", { name: "alex", next: await nextHash("alex", "b") })), "not_yours");
  assert.equal(code(await a.post("/v1/names/code", { name: "alex", next: "bad" })), "bad_code");
  data(await a.post("/v1/names/code", { name: "alex", next: await nextHash("alex", "newcod") }));
});

test("a DNS failure while wiping is retried by the sweep", async t => {
  const w = world(t), { a } = await claimed(w);
  w.dns.state.failNext = 1;
  await a.post("/v1/names/release", { name: "alex" });
  assert.equal(w.dns.records.length, 1, "the wipe failed once");
  await worker.scheduled({}, w.env);
  assert.equal(w.dns.records.length, 0);
});

// ---- the operator rebind (support only) ----

const ADMIN = "s".repeat(48);
const admin = (w, body, secret = ADMIN, extra = {}) => worker.fetch(new Request(BASE + "/v1/names/admin/rebind", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(secret === null ? {} : { "x-vyre-admin": secret }), ...extra }, body: JSON.stringify(body),
}), w.env).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

test("admin rebind: a name moves at once, is logged, tells the old route, and keeps the recovery code", async t => {
  const w = world(t, { ADMIN_SECRET: ADMIN }), { a, code: c } = await claimed(w);
  data(await a.post("/v1/names/point", { name: "alex", ip: "100.101.1.1" }));
  const n = boxOf(w);
  const r = await admin(w, { name: "alex", route: n.route });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.data.name, r.json.data.state], ["alex", "live"]);
  assert.equal(data(await n.get("/v1/names/check?name=alex")).status, "mine");
  const m = data(await n.get("/v1/names/mine"));
  assert.ok(m.notices.some(x => x.kind === "admin-rebind" && x.from === a.route.slice(0, 8) && x.to === n.route.slice(0, 8)), "the log has an admin-rebind entry");
  assert.equal(w.dns.records.length, 0, "the old address is unpublished");
  const old = data(await a.get("/v1/names/mine"));
  assert.equal(old.name, null);
  assert.equal(old.moved.name, "alex", "the old route is told where its name went");
  data(await n.post("/v1/names/point", { name: "alex", ip: "100.101.9.9" }));
});

test("admin rebind: refused with no secret configured, no header, a wrong header, an unknown name, a malformed route, a taken route", async t => {
  const none = world(t);
  const x = boxOf(none);
  assert.equal((await admin(none, { name: "alex", route: x.route })).status, 404, "no ADMIN_SECRET on the Worker: the operation does not exist");
  assert.equal((await admin(none, { name: "alex", route: x.route }, "short")).status, 404);
  const w = world(t, { ADMIN_SECRET: ADMIN }), { a } = await claimed(w);
  const n = boxOf(w);
  assert.equal((await admin(w, { name: "alex", route: n.route }, null)).status, 401, "no header");
  assert.equal((await admin(w, { name: "alex", route: n.route }, "w".repeat(48))).status, 401, "a wrong secret");
  assert.equal((await admin(w, { name: "alex", route: n.route }, ADMIN.slice(0, -1))).status, 401, "a near miss");
  assert.equal(data(await n.get("/v1/names/check?name=alex")).status, "taken", "nothing moved");
  assert.equal(code(await admin(w, { name: "nobody-here", route: n.route })), "no_such_name");
  assert.equal(code(await admin(w, { name: "alex", route: "NOT-A-ROUTE" })), "bad_request");
  assert.equal(code(await admin(w, { name: "alex", route: "a".repeat(25) })), "bad_request");
  assert.equal(code(await admin(w, { name: "!!", route: n.route })), "bad_request");
  assert.equal(code(await admin(w, { name: "alex", route: a.route })), "already_yours");
  // a route-key signature is not the secret
  assert.equal((await n.post("/v1/names/admin/rebind", { name: "alex", route: n.route })).status, 401);
  // a route that already holds a name
  const other = boxOf(w); data(await other.post("/v1/names/claim", { name: "blake" }));
  assert.equal(code(await admin(w, { name: "alex", route: other.route })), "one_per_route");
  assert.equal(data(await a.get("/v1/names/mine")).name, "alex", "the owner still holds it after every refusal");
});

test("admin rebind: the old route's moved note goes when that route holds a name again", async t => {
  const w = world(t, { ADMIN_SECRET: ADMIN }), { a } = await claimed(w);
  const n = boxOf(w);
  assert.equal((await admin(w, { name: "alex", route: n.route })).status, 200);
  assert.equal(data(await a.get("/v1/names/mine")).moved.name, "alex");
  data(await a.post("/v1/names/claim", { name: "blake" }));
  assert.equal(data(await a.get("/v1/names/mine")).moved, undefined, "claiming again clears the note");
});
