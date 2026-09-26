// @ts-check
// Tests run against a fake ACME server on 127.0.0.1 that checks what a real one checks: the
// JWS signature, alg ES256, a fresh single-use nonce, the url in the protected header, jwk only
// on newAccount and kid afterwards, and the DNS-01 key authorization in the fake zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { issue, newKey, expiry, needsRenewal, thumbprint, DIRECTORIES } from "./acme.js";

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** A self-signed certificate valid for `days`, made with openssl. */
function selfSigned(days = 90) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-acme-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=box1.example.test", "-days", String(days)], { stdio: "ignore" });
    return fs.readFileSync(path.join(dir, "c.pem"), "utf8");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const b64u = b => Buffer.from(b).toString("base64url");

/**
 * @param {{ cert?: string, badNonceOnce?: string, reject?: boolean, failChallenge?: boolean, txt: Map<string,string> }} o
 */
async function fakeAcme(t, o) {
  const nonces = new Set();
  const accounts = new Map(); // kid -> jwk
  const state = { badNonceSent: false, requests: [] };
  let base = "";
  const issueNonce = res => { const n = crypto.randomBytes(12).toString("base64url"); nonces.add(n); res.setHeader("Replay-Nonce", n); };
  const problem = (res, status, type, detail) => { res.statusCode = status; res.setHeader("content-type", "application/problem+json"); res.end(JSON.stringify({ type: "urn:ietf:params:acme:error:" + type, detail })); };
  const orders = new Map();

  const server = http.createServer(async (req, res) => {
    const url = base + req.url;
    if (req.url === "/directory") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ newNonce: base + "/nonce", newAccount: base + "/acct", newOrder: base + "/order" }));
    }
    issueNonce(res);
    if (req.url === "/nonce") { res.statusCode = 200; return res.end(); }
    let raw = "";
    for await (const c of req) raw += c;
    let jws, prot, payload;
    try {
      jws = JSON.parse(raw);
      prot = JSON.parse(Buffer.from(jws.protected, "base64url").toString());
      payload = jws.payload === "" ? null : JSON.parse(Buffer.from(jws.payload, "base64url").toString());
    } catch { return problem(res, 400, "malformed", "not a JWS"); }
    if (prot.alg !== "ES256") return problem(res, 400, "badSignatureAlgorithm", "ES256 only");
    if (prot.url !== url) return problem(res, 401, "unauthorized", "url mismatch");
    if (!nonces.delete(prot.nonce)) return problem(res, 400, "badNonce", "stale nonce");
    if (o.badNonceOnce === req.url && !state.badNonceSent) { state.badNonceSent = true; return problem(res, 400, "badNonce", "try again"); }
    let jwk;
    if (req.url === "/acct") {
      if (!prot.jwk || prot.kid) return problem(res, 400, "malformed", "newAccount needs jwk");
      jwk = prot.jwk;
    } else {
      if (prot.jwk || !accounts.has(prot.kid)) return problem(res, 401, "accountDoesNotExist", "kid required");
      jwk = accounts.get(prot.kid);
    }
    const ok = crypto.verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url"));
    if (!ok) return problem(res, 400, "malformed", "bad signature");
    state.requests.push({ path: req.url, payload });
    res.setHeader("content-type", "application/json");
    const send = (status, body, loc) => { res.statusCode = status; if (loc) res.setHeader("Location", loc); res.end(JSON.stringify(body)); };

    if (req.url === "/acct") {
      if (payload.termsOfServiceAgreed !== true) return problem(res, 400, "malformed", "agree to the terms");
      const kid = base + "/acct/" + thumbprint(jwk).slice(0, 8);
      const existed = accounts.has(kid);
      accounts.set(kid, jwk);
      return send(existed ? 200 : 201, { status: "valid", contact: payload.contact }, kid);
    }
    if (req.url === "/order") {
      const ids = payload.identifiers;
      if (o.reject) return problem(res, 400, "rejectedIdentifier", `Invalid identifiers requested :: ${ids[0].value}`);
      const id = String(orders.size + 1);
      const order = { status: "pending", identifiers: ids, authorizations: ids.map((_, i) => `${base}/authz/${id}/${i}`), finalize: `${base}/finalize/${id}`,
        authz: ids.map(x => ({ identifier: x, status: "pending", challenges: [{ type: "http-01", url: base + "/nope", token: "h" }, { type: "dns-01", url: `${base}/chall/${id}/${ids.indexOf(x)}`, token: crypto.randomBytes(16).toString("base64url"), status: "pending" }] })),
        thumb: thumbprint(jwk) };
      orders.set(id, order);
      return send(201, view(order), `${base}/orders/${id}`);
    }
    let m;
    if ((m = req.url.match(/^\/authz\/(\d+)\/(\d+)$/))) {
      const a = orders.get(m[1]).authz[+m[2]];
      return send(200, { identifier: a.identifier, status: a.status, challenges: a.challenges.map(({ type, url, token, status, error }) => ({ type, url, token, status, error })) });
    }
    if ((m = req.url.match(/^\/chall\/(\d+)\/(\d+)$/))) {
      const order = orders.get(m[1]);
      const a = order.authz[+m[2]];
      const ch = a.challenges[1];
      const want = b64u(crypto.createHash("sha256").update(`${ch.token}.${order.thumb}`).digest());
      const seen = o.txt.get("_acme-challenge." + a.identifier.value);
      if (o.failChallenge || seen !== want) {
        a.status = ch.status = "invalid";
        ch.error = { type: "urn:ietf:params:acme:error:unauthorized", detail: "Incorrect TXT record found" };
      } else a.status = ch.status = "valid";
      if (order.authz.every(x => x.status === "valid")) order.status = "ready";
      return send(200, { type: "dns-01", url: ch.url, token: ch.token, status: ch.status });
    }
    if ((m = req.url.match(/^\/finalize\/(\d+)$/))) {
      const order = orders.get(m[1]);
      if (order.status !== "ready") return problem(res, 403, "orderNotReady", "not ready");
      const der = Buffer.from(payload.csr, "base64url");
      if (der[0] !== 0x30) return problem(res, 400, "badCSR", "not DER");
      order.status = "processing";
      order.csrSeen = der;
      return send(200, view(order), `${base}/orders/${m[1]}`);
    }
    if ((m = req.url.match(/^\/orders\/(\d+)$/))) {
      const order = orders.get(m[1]);
      if (order.status === "processing") { order.polls = (order.polls || 0) + 1; if (order.polls >= 2) { order.status = "valid"; order.certificate = `${base}/cert/${m[1]}`; } }
      return send(200, view(order));
    }
    if ((m = req.url.match(/^\/cert\/(\d+)$/))) {
      if (payload !== null) return problem(res, 400, "malformed", "POST-as-GET only");
      res.setHeader("content-type", "application/pem-certificate-chain");
      return res.end(o.cert);
    }
    problem(res, 404, "malformed", "no such resource");
  });
  const view = ({ status, identifiers, authorizations, finalize, certificate }) => ({ status, identifiers, authorizations, finalize, certificate });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { directory: base + "/directory", state };
}

/** A fake DNS adapter over a Map, recording what was set and cleared. */
function fakeDns() {
  const txt = new Map();
  const log = { set: [], cleared: [] };
  return {
    txt, log,
    adapter: {
      async set(fqdn, value) { txt.set(fqdn, value); log.set.push(fqdn); return "h:" + fqdn; },
      async clear(h) { txt.delete(h.slice(2)); log.cleared.push(h); },
    },
  };
}

test("acme: the directory URLs are Let's Encrypt's", () => {
  assert.match(DIRECTORIES.production, /^https:\/\/acme-v02\.api\.letsencrypt\.org\/directory$/);
  assert.match(DIRECTORIES.staging, /^https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/directory$/);
});

test("acme: newKey is a P-256 PKCS#8 key", () => {
  const k = crypto.createPrivateKey(newKey());
  assert.equal(k.asymmetricKeyType, "ec");
  assert.equal(/** @type {any} */ (k.asymmetricKeyDetails).namedCurve, "prime256v1");
});

test("acme: thumbprint matches the RFC 7638 example shape", () => {
  // Member order and whitespace must not change the thumbprint.
  const jwk = { y: "yy", x: "xx", kty: "EC", crv: "P-256" };
  const expect = crypto.createHash("sha256").update('{"crv":"P-256","kty":"EC","x":"xx","y":"yy"}').digest("base64url");
  assert.equal(thumbprint(jwk), expect);
});

test("acme: happy path issues a certificate and clears every TXT record", { skip: !hasOpenssl && "openssl is needed to make the fake CA's certificate" }, async t => {
  const dns = fakeDns();
  const cert = selfSigned(90);
  const acme = await fakeAcme(t, { cert, txt: dns.txt });
  const waited = [];
  const out = await issue({ names: ["box1.example.test", "alt.example.test"], directory: acme.directory, accountKey: newKey(), dns: dns.adapter, pollMs: 5,
    waitDns: async (fqdn, value) => { waited.push(fqdn); assert.equal(dns.txt.get(fqdn), value); } });
  assert.equal(out.cert, cert);
  assert.equal(crypto.createPrivateKey(out.key).asymmetricKeyType, "ec");
  assert.ok(Math.abs(out.expires - (Date.now() + 90 * 86400000)) < 2 * 86400000);
  assert.deepEqual(dns.log.set, ["_acme-challenge.box1.example.test", "_acme-challenge.alt.example.test"]);
  assert.deepEqual(waited, dns.log.set);
  assert.equal(dns.log.cleared.length, 2);
  assert.equal(dns.txt.size, 0);
  const acct = acme.state.requests.find(r => r.path === "/acct");
  assert.equal(acct.payload.contact, undefined, "no contact without an email");
});

test("acme: a given email becomes the account contact", { skip: !hasOpenssl && "openssl is needed to make the fake CA's certificate" }, async t => {
  const dns = fakeDns();
  const acme = await fakeAcme(t, { cert: selfSigned(), txt: dns.txt });
  await issue({ names: ["box1.example.test"], directory: acme.directory, accountKey: newKey(), email: "ops@example.test", dns: dns.adapter, pollMs: 5 });
  assert.deepEqual(acme.state.requests.find(r => r.path === "/acct").payload.contact, ["mailto:ops@example.test"]);
});

test("acme: a badNonce is retried once with a fresh nonce", { skip: !hasOpenssl && "openssl is needed to make the fake CA's certificate" }, async t => {
  const dns = fakeDns();
  const acme = await fakeAcme(t, { cert: selfSigned(), txt: dns.txt, badNonceOnce: "/order" });
  const logs = [];
  const out = await issue({ names: ["box1.example.test"], directory: acme.directory, accountKey: newKey(), dns: dns.adapter, pollMs: 5, log: m => logs.push(m) });
  assert.ok(out.cert);
  assert.equal(acme.state.badNonceSent, true);
  assert.ok(logs.some(l => /bad nonce/.test(l)));
});

test("acme: a rejected identifier throws with the problem type and detail", async t => {
  const dns = fakeDns();
  const acme = await fakeAcme(t, { cert: "", txt: dns.txt, reject: true });
  await assert.rejects(
    issue({ names: ["bad_label.example.test"], directory: acme.directory, accountKey: newKey(), dns: dns.adapter, pollMs: 5 }),
    err => {
      assert.match(err.message, /urn:ietf:params:acme:error:rejectedIdentifier: Invalid identifiers requested/);
      assert.equal(err.problem.type, "urn:ietf:params:acme:error:rejectedIdentifier");
      return true;
    });
  assert.equal(dns.log.set.length, 0);
});

test("acme: a failed challenge still clears the TXT record", async t => {
  const dns = fakeDns();
  const acme = await fakeAcme(t, { cert: "", txt: dns.txt, failChallenge: true });
  await assert.rejects(
    issue({ names: ["box1.example.test"], directory: acme.directory, accountKey: newKey(), dns: dns.adapter, pollMs: 5 }),
    /urn:ietf:params:acme:error:unauthorized: Incorrect TXT record/);
  assert.deepEqual(dns.log.cleared, ["h:_acme-challenge.box1.example.test"]);
  assert.equal(dns.txt.size, 0);
});

test("acme: a failing propagation wait still clears every record", async t => {
  const dns = fakeDns();
  const acme = await fakeAcme(t, { cert: "", txt: dns.txt });
  await assert.rejects(
    issue({ names: ["a.example.test", "b.example.test"], directory: acme.directory, accountKey: newKey(), dns: dns.adapter, pollMs: 5,
      waitDns: async () => { throw new Error("TXT never propagated"); } }),
    /never propagated/);
  assert.equal(dns.log.cleared.length, 2);
});

test("acme: expiry and needsRenewal read the first certificate", { skip: !hasOpenssl && "openssl is needed to make a certificate" }, () => {
  const pem = selfSigned(60);
  const t = expiry(pem + pem);
  assert.ok(Math.abs(t - (Date.now() + 60 * 86400000)) < 2 * 86400000);
  assert.equal(needsRenewal(pem), false);
  assert.equal(needsRenewal(pem, Date.now() + 31 * 86400000), true);
  assert.equal(needsRenewal(pem, Date.now(), 61), true);
  assert.equal(needsRenewal("not a cert"), true);
  assert.throws(() => expiry("nothing"), /no certificate/);
});
