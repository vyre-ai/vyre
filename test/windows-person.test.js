// The Windows link page's person session (local/capsule/native-win/app/ui/person.js): the same start call and per-request proof the phone app makes
// (apps/app/src/auth/person.ts), checked here with Node's crypto the way the box's core/presence/person.js checks them.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { personSession, proofMessage } from "../local/capsule/native-win/app/ui/person.js";

const TOKEN = "abcdefgh12345678.0123456789abcdef0123456789abcdef";

test("windows person session: it starts with a presence proof for its own key, then signs every request with that key", async () => {
  const calls = [];
  let jwk;
  const session = personSession({
    now: () => 1_700_000_000_000,
    presenceProof: async (key) => { jwk = key; return "device key=KID ts=1 nonce=n0000000001 sig=x"; },
    send: async (path, init) => { calls.push({ path, init }); return { status: 200, json: async () => ({ data: { token: TOKEN, expires: 1_700_000_900_000 } }) }; },
  });
  const h = await session.headers("POST", "/v1/tools/link.companion.pair", '{"a":1}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/tools/presence.person.start");
  assert.equal(calls[0].init.headers["x-vyre-presence"], "device key=KID ts=1 nonce=n0000000001 sig=x");
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: jwk });
  assert.deepEqual(Object.keys(jwk).sort(), ["crv", "kty", "x", "y"], "a public key and nothing else");
  assert.equal(h.authorization, `Vyre ${TOKEN}`);
  const m = /^t=(\d+) n=([A-Za-z0-9_-]+) sig=([A-Za-z0-9_-]+)$/.exec(h["x-vyre-proof"]);
  assert.ok(m);
  const msg = await proofMessage({ method: "POST", path: "/v1/tools/link.companion.pair", body: '{"a":1}', t: m[1], n: m[2] });
  assert.equal(msg, `POST\n/v1/tools/link.companion.pair\n${crypto.createHash("sha256").update('{"a":1}').digest("base64url")}\n${m[1]}\n${m[2]}`);
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  assert.equal(crypto.verify("sha256", Buffer.from(msg), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")), true);
  // A second request reuses the session; a changed body is a different proof.
  const h2 = await session.headers("POST", "/v1/tools/link.companion.pair", '{"a":2}');
  assert.equal(calls.length, 1);
  assert.notEqual(h2["x-vyre-proof"], h["x-vyre-proof"]);
});

test("windows person session: a refused start says why, and a forgotten or expired session starts again", async () => {
  let n = 0;
  const bad = personSession({ presenceProof: async () => "p", send: async () => ({ status: 403, json: async () => ({ error: { code: "denied", message: "the device key is not enrolled" } }) }) });
  await assert.rejects(() => bad.headers("GET", "/v1/health"), /the device key is not enrolled/);
  let clock = 1_000_000;
  const s = personSession({ now: () => clock, presenceProof: async () => "p", send: async () => ({ status: 200, json: async () => ({ data: { token: TOKEN, expires: clock + 120_000 } }) && (n++, { data: { token: TOKEN, expires: clock + 120_000 } }) }) });
  await s.headers("GET", "/x"); await s.headers("GET", "/x");
  assert.equal(n, 1);
  s.forget(); await s.headers("GET", "/x");
  assert.equal(n, 2);
  clock += 100_000; await s.headers("GET", "/x");
  assert.equal(n, 3, "within a minute of expiry it starts a new one");
});
