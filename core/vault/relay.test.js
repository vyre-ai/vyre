// @ts-check
// relay tests: encoding, envelope checks, the host allowlist, substitution, scrubbing, the
// outbound send and the listener. Every server here binds to 127.0.0.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { newIdentity } from "./crypto.js";
import {
  encodeCard, decodeCard, encodeTicket, decodeTicket, envelope, checkEnvelope,
  allowedOrigin, substitute, scrub, send, serve, callRelay,
} from "./relay.js";

/** @param {http.RequestListener} handler */
async function local(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }) };
}

test("card round-trips and a bad prefix is refused", () => {
  const card = { name: "laptop", sign: "c2lnbg==", box: "Ym94", relay: "http://127.0.0.1:4567" };
  const s = encodeCard(card);
  assert.ok(s.startsWith("vyre-card:v1:"));
  assert.deepEqual(decodeCard(s), card);
  assert.throws(() => decodeCard(s.replace("vyre-card", "vyre-kard")), /should start with "vyre-card:v1:"/);
  assert.throws(() => decodeCard("vyre-card:v1:!!!"), /damaged/);
  assert.throws(() => encodeCard(/** @type {any} */ ({ name: "x" })), /missing "sign"/);
});

test("ticket round-trips in both modes and a bad prefix is refused", () => {
  const base = { pass: "p1", owner: "owner", relay: "http://127.0.0.1:4567", ownerSign: "a2V5", holder: "holder", items: ["github"], expires: null };
  const relayed = /** @type {any} */ ({ ...base, mode: "relayed" });
  assert.deepEqual(decodeTicket(encodeTicket(relayed)), relayed);
  const sealed = /** @type {any} */ ({ ...base, mode: "sealed", expires: 123, sealed: { github: { v: 1, epk: "x", iv: "y", tag: "z", ct: "w" } } });
  assert.deepEqual(decodeTicket(encodeTicket(sealed)), sealed);
  assert.throws(() => decodeTicket(encodeTicket(relayed).replace("vyre-pass:v1:", "vyre-pass:v2:")), /should start with "vyre-pass:v1:"/);
  assert.throws(() => decodeTicket(encodeCard({ name: "a", sign: "b", box: "c", relay: "d" })), /not a pass ticket/);
  assert.throws(() => encodeTicket({ ...relayed, mode: "open" }), /mode/);
  assert.throws(() => encodeTicket({ ...sealed, sealed: {} }), /missing item "github"/);
});

test("envelope verifies, and tampering, an old ts and a replay each fail", () => {
  const id = newIdentity();
  const request = { method: "GET", url: "https://api.example.com/user", headers: { authorization: "Bearer {{vault}}" } };
  const now = 1_800_000_000_000;
  const seen = new Map();
  const env = envelope({ pass: "p1", item: "github", request, privDer: id.sign.private, now });
  assert.equal(env.nonce.length, 22);
  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, now, seen }), null);
  assert.ok(seen.has(env.nonce));

  const tampered = { ...env, request: { ...request, url: "https://evil.example.com/" } };
  assert.equal(checkEnvelope(tampered, { holderKey: id.sign.public, now, seen: new Map() }), "bad signature");
  assert.equal(checkEnvelope(env, { holderKey: newIdentity().sign.public, now, seen: new Map() }), "bad signature");

  const old = envelope({ pass: "p1", item: "github", request, privDer: id.sign.private, now: now - 61_000 });
  assert.match(String(checkEnvelope(old, { holderKey: id.sign.public, now, seen: new Map() })), /timestamp/);

  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, now: now + 1000, seen }), "replayed nonce");
  // Entries older than 120 s are dropped.
  checkEnvelope({}, { holderKey: id.sign.public, now: now + 121_000, seen });
  assert.equal(seen.size, 0);
  assert.equal(checkEnvelope(null, { holderKey: id.sign.public, now, seen }), "malformed envelope");
});

test("allowedOrigin matches scheme, host and port exactly", () => {
  const hosts = ["https://api.example.com", "http://127.0.0.1:4567"];
  assert.equal(allowedOrigin("https://api.example.com/v1/user?x=1", hosts), true);
  assert.equal(allowedOrigin("https://api.example.com:443/", hosts), true);
  assert.equal(allowedOrigin("http://127.0.0.1:4567/anything", hosts), true);
  assert.equal(allowedOrigin("https://api.example.com:8443/", hosts), false);
  assert.equal(allowedOrigin("http://127.0.0.1:4568/", hosts), false);
  assert.equal(allowedOrigin("http://api.example.com/", hosts), false);
  assert.equal(allowedOrigin("https://evil.api.example.com/", hosts), false);
  assert.equal(allowedOrigin("https://api.example.com.evil.com/", hosts), false);
  assert.equal(allowedOrigin("javascript:alert(1)", hosts), false);
  assert.equal(allowedOrigin("not a url", hosts), false);
  assert.equal(allowedOrigin("https://api.example.com/", []), false);
});

test("substitute fills headers and body and refuses the url", () => {
  const fields = { token: "tok_abcdef123", user: "robot" };
  const req = { method: "POST", url: "https://api.example.com/x", headers: { authorization: "Bearer {{vault}}", "x-user": "{{ vault.user }}" }, body: '{"t":"{{vault.token}}"}' };
  const { request, values } = substitute(req, fields, "token");
  assert.equal(request.headers?.authorization, "Bearer tok_abcdef123");
  assert.equal(request.headers?.["x-user"], "robot");
  assert.equal(request.body, '{"t":"tok_abcdef123"}');
  assert.deepEqual(values.sort(), ["robot", "tok_abcdef123"]);
  assert.equal(req.headers.authorization, "Bearer {{vault}}", "the input is not modified");
  assert.throws(() => substitute({ url: "https://api.example.com/?k={{vault}}" }, fields, "token"), /cannot go in the url/);
  assert.throws(() => substitute({ url: "https://api.example.com/", headers: { a: "{{vault.nope}}" } }, fields, "token"), /no field "nope"/);
});

test("scrub removes raw, base64 and URL-encoded forms", () => {
  const v = "s3cr3t value/+=";
  const text = `raw ${v} b64 ${Buffer.from(v).toString("base64")} url ${encodeURIComponent(v)} short abc`;
  const out = scrub(text, [v, "abc"]);
  assert.ok(!out.includes(v));
  assert.ok(!out.includes(Buffer.from(v).toString("base64")));
  assert.ok(!out.includes(encodeURIComponent(v)));
  assert.equal(out.split("<concealed by vyre>").length - 1, 3);
  assert.ok(out.endsWith("short abc"), "values under 4 chars are left alone");
});

test("send does not follow redirects", async () => {
  let followed = false;
  const srv = await local((req, res) => {
    if (req.url === "/next") { followed = true; res.end("followed"); return; }
    res.writeHead(302, { location: "/next", "content-type": "text/plain" }); res.end("moved");
  });
  try {
    const r = await send({ url: srv.url + "/start" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/next");
    assert.equal(r.headers["content-type"], "text/plain");
    assert.equal(followed, false);
  } finally { await srv.close(); }
});

test("send throws past maxBytes and times out", async () => {
  const srv = await local((req, res) => {
    if (req.url === "/slow") return; // never answers
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(10_000));
  });
  try {
    await assert.rejects(send({ url: srv.url + "/big" }, { maxBytes: 1000 }), /larger than 1000 bytes/);
    const ok = await send({ url: srv.url + "/big" }, { maxBytes: 20_000 });
    assert.equal(ok.body.length, 10_000);
    await assert.rejects(send({ url: srv.url + "/slow" }, { timeoutMs: 200 }), /no response within 200 ms/);
    await assert.rejects(send({ url: "file:///etc/hosts" }), /http or https/);
  } finally { await srv.close(); }
});

test("serve and callRelay round-trip", async () => {
  const id = newIdentity();
  /** @type {any[]} */
  const got = [];
  const relay = await serve({ onRelay: async (env, meta) => {
    got.push({ env, meta });
    if (env.item === "boom") throw new Error("kaboom");
    return { status: 200, body: { data: { status: 200, body: "hello " + env.item } } };
  } });
  try {
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const env = envelope({ pass: "p1", item: "github", request: { url: "https://api.example.com/" }, privDer: id.sign.private });
    const r = await callRelay(relay.url, env);
    assert.deepEqual(r, { data: { status: 200, body: "hello github" } });
    assert.deepEqual(got[0].env, env);
    assert.equal(got[0].meta.remoteAddress, "127.0.0.1");

    const bad = await callRelay(relay.url, { ...env, item: "boom" });
    assert.deepEqual(bad, { error: { code: "internal", message: "kaboom" } });

    const miss = await fetch(relay.url + "/v1/other", { method: "POST", body: "{}" });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.code, "not_found");
    const get = await fetch(relay.url + "/v1/relay");
    assert.equal(get.status, 404);
    const junk = await fetch(relay.url + "/v1/relay", { method: "POST", body: "not json" });
    assert.equal(junk.status, 400);
  } finally { await relay.close(); }
});

test("callRelay to a closed port is unreachable", async () => {
  const srv = await local((req, res) => res.end());
  const url = srv.url;
  await srv.close();
  const r = await callRelay(url, /** @type {any} */ ({ pass: "p" }), { timeoutMs: 2000 });
  assert.equal(r.error.code, "unreachable");
});
