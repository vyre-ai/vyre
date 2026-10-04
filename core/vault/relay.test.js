// @ts-check
// relay tests: encoding, envelope checks, the host allowlist, substitution, scrubbing, the
// outbound send and the listener. Every server here binds to 127.0.0.1.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newIdentity } from "./crypto.js";
import { SCRATCH } from "../../test/scratch.mjs";
import {
  encodeCard, decodeCard, encodeTicket, decodeTicket, envelope, checkEnvelope, dbNonces, secureTarget, isLoopback,
  requestAllowed, checkBind, allowedOrigin, substitute, scrub, send, serve, callRelay,
} from "./relay.js";

/** @param {http.RequestListener} handler */
async function local(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }) };
}

const ID = newIdentity();
const CARD = { name: "laptop", sign: ID.sign.public, box: ID.box.public, relay: "http://127.0.0.1:4567" };

test("v2 card round-trips signed; tampering, a wrong prefix and a malformed body are refused; v1 still reads", () => {
  const s = encodeCard(CARD, ID.sign.private);
  assert.ok(s.startsWith("vyre-card:v2:"));
  const c = decodeCard(s);
  assert.equal(c.v, 2);
  assert.deepEqual({ name: c.name, sign: c.sign, box: c.box, relay: c.relay, devices: c.devices }, { ...CARD, devices: [] });
  const body = JSON.parse(Buffer.from(s.slice(13), "base64url").toString());
  const forged = "vyre-card:v2:" + Buffer.from(JSON.stringify({ ...body, relay: "https://evil.example.com" })).toString("base64url");
  assert.throws(() => decodeCard(forged), /signature does not match/);
  assert.throws(() => decodeCard(encodeCard(CARD, newIdentity().sign.private)), /signature does not match/);
  assert.throws(() => decodeCard(s.replace("vyre-card", "vyre-kard")), /should start with "vyre-card:v2:"/);
  assert.throws(() => decodeCard("vyre-card:v2:!!!"), /damaged/);
  assert.throws(() => encodeCard(/** @type {any} */ ({ name: "x" }), ID.sign.private), /missing "sign"/);
  const v1 = "vyre-card:v1:" + Buffer.from(JSON.stringify(CARD)).toString("base64url");
  assert.deepEqual(decodeCard(v1), { v: 1, ...CARD });
});

const OWNER = newIdentity(), HOLDER = newIdentity();
const ownerCard = encodeCard({ name: "owner", sign: OWNER.sign.public, box: OWNER.box.public, relay: "http://127.0.0.1:4567" }, OWNER.sign.private);
const BASE = { pass: "p1", owner: "owner", relay: "http://127.0.0.1:4567", ownerSign: OWNER.sign.public, ownerCard, holder: "holder", holderSign: HOLDER.sign.public, items: ["github"], expires: null };

test("tickets are signed by the owner; forged, re-signed and old unsigned tickets are refused", () => {
  const relayed = /** @type {any} */ ({ ...BASE, mode: "relayed" });
  const t = encodeTicket(relayed, OWNER.sign.private);
  assert.ok(t.startsWith("vyre-pass:v2:"));
  const back = decodeTicket(t);
  assert.ok(back.sig);
  assert.deepEqual({ ...back, sig: undefined }, { ...relayed, sig: undefined });
  const sealed = /** @type {any} */ ({ ...BASE, mode: "sealed", expires: 123, sealed: { github: { v: 1, epk: "x", iv: "y", tag: "z", ct: "w" } } });
  assert.equal(decodeTicket(encodeTicket(sealed, OWNER.sign.private)).mode, "sealed");

  // Edited after signing: a relay pointed elsewhere.
  const body = JSON.parse(Buffer.from(t.slice(13), "base64url").toString());
  const edited = "vyre-pass:v2:" + Buffer.from(JSON.stringify({ ...body, relay: "https://evil.example.com" })).toString("base64url");
  assert.throws(() => decodeTicket(edited), /signature does not match/);
  // Signed by someone else claiming the owner's key.
  assert.throws(() => decodeTicket(encodeTicket(relayed, newIdentity().sign.private)), /signature does not match/);
  // A forger's own key, but with the owner's card: the card is for a different key.
  const mallory = newIdentity();
  assert.throws(() => decodeTicket(encodeTicket({ ...relayed, ownerSign: mallory.sign.public }, mallory.sign.private)), /different key/);
  const old = "vyre-pass:v1:" + Buffer.from(JSON.stringify({ ...relayed, ownerCard: undefined })).toString("base64url");
  assert.throws(() => decodeTicket(old), /older Vyre and is not signed, so nothing proves owner made it/);
  assert.throws(() => decodeTicket(ownerCard), /not a pass ticket/);
  assert.throws(() => encodeTicket({ ...relayed, mode: "open" }, OWNER.sign.private), /mode/);
  assert.throws(() => encodeTicket({ ...sealed, sealed: {} }, OWNER.sign.private), /missing item "github"/);
  assert.throws(() => encodeTicket({ ...relayed, holderSign: undefined }, OWNER.sign.private), /missing "holderSign"/);
  assert.ok(!decodeTicket(t).sealed, "a relayed ticket carries nothing sealed");
});

test("envelope verifies for its audience; tampering, another audience, v1, an old ts and a replay each fail", () => {
  const id = newIdentity();
  const aud = "https://owner.example.com";
  const request = { method: "GET", url: "https://api.example.com/user", headers: { authorization: "Bearer {{vault}}" } };
  const now = 1_800_000_000_000;
  const seen = new Map();
  const env = envelope({ pass: "p1", item: "github", request, privDer: id.sign.private, aud, now });
  assert.equal(env.nonce.length, 22);
  assert.equal(env.v, 2);
  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, audience: aud, now, seen }), null);
  assert.ok(seen.has(env.nonce));

  const tampered = { ...env, request: { ...request, url: "https://evil.example.com/" } };
  assert.equal(checkEnvelope(tampered, { holderKey: id.sign.public, audience: aud, now, seen: new Map() }), "bad signature");
  assert.equal(checkEnvelope(env, { holderKey: newIdentity().sign.public, audience: aud, now, seen: new Map() }), "bad signature");
  assert.match(String(checkEnvelope(env, { holderKey: id.sign.public, audience: "https://other.example.com", now, seen: new Map() })), /another relay/);
  // Moving the audience to match the other relay breaks the signature.
  assert.equal(checkEnvelope({ ...env, aud: "https://other.example.com" }, { holderKey: id.sign.public, audience: "https://other.example.com", now, seen: new Map() }), "bad signature");
  const { v, aud: _a, ...v1 } = env;
  assert.match(String(checkEnvelope(v1, { holderKey: id.sign.public, audience: aud, now, seen: new Map() })), /older Vyre/);

  const old = envelope({ pass: "p1", item: "github", request, privDer: id.sign.private, aud, now: now - 61_000 });
  assert.match(String(checkEnvelope(old, { holderKey: id.sign.public, audience: aud, now, seen: new Map() })), /timestamp/);
  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, audience: aud, now: now + 1000, seen }), "replayed nonce");
  // Entries older than 120 s are dropped.
  checkEnvelope({}, { holderKey: id.sign.public, audience: aud, now: now + 121_000, seen });
  assert.equal(seen.size, 0);
  assert.equal(checkEnvelope(null, { holderKey: id.sign.public, audience: aud, now, seen }), "malformed envelope");
});

test("nonces in vyre.db survive a restart and expire after 120 s", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-nonce-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vyre.db");
  const open = () => { const db = new DatabaseSync(file); db.exec("CREATE TABLE IF NOT EXISTS vault_relay_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL)"); return db; };
  const id = newIdentity(), aud = "https://owner.example.com", now = 1_800_000_000_000;
  const env = envelope({ pass: "p1", item: "github", request: { url: "https://api.example.com/" }, privDer: id.sign.private, aud, now });
  let db = open();
  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, audience: aud, now, seen: dbNonces(db) }), null);
  db.close();
  db = open(); // vyred restarted
  assert.equal(checkEnvelope(env, { holderKey: id.sign.public, audience: aud, now: now + 30_000, seen: dbNonces(db) }), "replayed nonce");
  dbNonces(db).prune(now + 121_000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vault_relay_nonces").get()?.n, 0);
  db.close();
});

test("https is required off loopback; method and path allowlists match by prefix after normalising", () => {
  assert.equal(secureTarget("https://api.example.com/"), true);
  assert.equal(secureTarget("http://api.example.com/"), false);
  for (const u of ["http://127.0.0.1:9/", "http://localhost/", "http://[::1]:80/", "http://127.8.9.10/"]) assert.equal(secureTarget(u), true, u);
  assert.equal(secureTarget("http://127.0.0.1.example.com/"), false);
  assert.equal(isLoopback("0.0.0.0"), false);
  assert.equal(requestAllowed({ url: "https://api.example.com/v1/charges" }, {}), null);
  assert.equal(requestAllowed({ method: "get", url: "https://api.example.com/v1/charges/ch_1" }, { methods: ["GET"], paths: ["/v1/charges"] }), null);
  assert.match(String(requestAllowed({ method: "POST", url: "https://api.example.com/v1/charges" }, { methods: ["GET"] })), /only GET/);
  assert.match(String(requestAllowed({ url: "https://api.example.com/gists" }, { paths: ["/v1/"] })), /only paths under \/v1\//);
  assert.match(String(requestAllowed({ url: "https://api.example.com/v1/../gists" }, { paths: ["/v1/"] })), /only paths/);
  assert.match(String(requestAllowed({ url: "https://api.example.com/v1/%2e%2e/gists" }, { paths: ["/v1/"] })), /only paths/);
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

test("substitute fills headers, fills the body only when the item allows it, and refuses the url", () => {
  const fields = { token: "tok_abcdef123", user: "robot" };
  const req = { method: "POST", url: "https://api.example.com/x", headers: { authorization: "Bearer {{vault}}", "x-user": "{{ vault.user }}" }, body: '{"t":"{{vault.token}}"}' };
  assert.throws(() => substitute(req, fields, "token"), /headers only/);
  const { request, values } = substitute(req, fields, "token", { body: true });
  assert.equal(request.headers?.authorization, "Bearer tok_abcdef123");
  assert.equal(request.headers?.["x-user"], "robot");
  assert.equal(request.body, '{"t":"tok_abcdef123"}');
  assert.deepEqual(values.sort(), ["robot", "tok_abcdef123"]);
  assert.equal(req.headers.authorization, "Bearer {{vault}}", "the input is not modified");
  const plain = substitute({ ...req, body: '{"public":"gist"}' }, fields, "token");
  assert.equal(plain.request.body, '{"public":"gist"}', "a body without placeholders goes as it is");
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

test("serve and callRelay round-trip; a 500 carries no message; the login header needs identity tailscale", async () => {
  const id = newIdentity();
  /** @type {any[]} */
  const got = [];
  const secret = "fixture-" + "internal-detail-7f3a";
  const onRelay = async (env, meta) => {
    got.push({ env, meta });
    if (env.item === "boom") throw new Error("kaboom " + secret);
    return { status: 200, body: { data: { status: 200, body: "hello " + env.item } } };
  };
  const relay = await serve({ onRelay });
  try {
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const env = envelope({ pass: "p1", item: "github", request: { url: "https://api.example.com/" }, privDer: id.sign.private, aud: relay.url });
    const r = await callRelay(relay.url, env);
    assert.deepEqual(r, { data: { status: 200, body: "hello github" } });
    assert.deepEqual(got[0].env, env);
    assert.equal(got[0].meta.remoteAddress, "127.0.0.1");

    const bad = await callRelay(relay.url, { ...env, item: "boom" });
    assert.equal(bad.error.code, "internal");
    assert.ok(!JSON.stringify(bad).includes("kaboom") && !JSON.stringify(bad).includes(secret), "a 500 must not carry the error message");

    const forged = await fetch(relay.url + "/v1/relay", { method: "POST", headers: { "tailscale-user-login": "alex@example.com" }, body: JSON.stringify(env) });
    assert.equal(forged.status, 200);
    assert.equal(got.at(-1).meta.login, null, "without identity tailscale the header is ignored");

    const miss = await fetch(relay.url + "/v1/other", { method: "POST", body: "{}" });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.code, "not_found");
    const get = await fetch(relay.url + "/v1/relay");
    assert.equal(get.status, 404);
    const junk = await fetch(relay.url + "/v1/relay", { method: "POST", body: "not json" });
    assert.equal(junk.status, 400);
  } finally { await relay.close(); }

  const ts = await serve({ identity: "tailscale", onRelay });
  try {
    await fetch(ts.url + "/v1/relay", { method: "POST", headers: { "tailscale-user-login": "alex@example.com" }, body: "{}" });
    assert.equal(got.at(-1).meta.login, "alex@example.com");
  } finally { await ts.close(); }
  await assert.rejects(serve({ host: "0.0.0.0", identity: "tailscale", onRelay }), /needs vault.relay.host to be 127.0.0.1/);
  assert.throws(() => checkBind("100.64.0.1", "tailscale"), /forge the Tailscale login header/);
  assert.doesNotThrow(() => checkBind("0.0.0.0", null));
});

test("callRelay to a closed port is unreachable", async () => {
  const srv = await local((req, res) => res.end());
  const url = srv.url;
  await srv.close();
  const r = await callRelay(url, /** @type {any} */ ({ pass: "p" }), { timeoutMs: 2000 });
  assert.equal(r.error.code, "unreachable");
});
