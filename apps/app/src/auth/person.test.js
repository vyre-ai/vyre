// @ts-check
// The person session's pure pieces (person.ts) in Node with globalThis.crypto.subtle: PKCE, the
// proof message, a signature the box can verify (P1363), the token trade, and a 401
// person_session_required forgetting the token. No DOM, no network.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { caller } from "../../../../core/resilience/web.js";
import { memoryStore } from "../../../../core/resilience/outbox.js";
import { backoff } from "../../../../core/resilience/backoff.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./person.ts");
const BOX = "https://juniper.example.ts.net";
const enc = new TextEncoder();

/** @param {() => boolean} ok */
async function until(ok) { for (let i = 0; i < 500 && !ok(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(ok(), "timed out"); }

test("person: PKCE S256 matches RFC 7636 Appendix B", { skip: !strip }, async () => {
  const { pkce, challengeFor } = await load();
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(await challengeFor(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const fresh = await pkce();
  assert.match(fresh.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(fresh.challenge, /^[A-Za-z0-9_-]{43}$/, "the box takes a 43-character base64url challenge");
  assert.equal(fresh.challenge, await challengeFor(fresh.verifier));
});

test("person: base64url round-trips every length, no padding", { skip: !strip }, async () => {
  const { b64url, fromB64url } = await load();
  for (let n = 0; n < 40; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    const s = b64url(bytes);
    assert.equal(s, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(fromB64url(s), bytes);
  }
});

test("person: proofMessage is METHOD, path?query, body hash, t and n on five lines", { skip: !strip }, async () => {
  const { proofMessage, pathOf } = await load();
  const body = '{"name":"kit"}';
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(body))).toString("base64url");
  assert.equal(await proofMessage({ method: "post", path: "/v1/tools/agents.update?x=1", body, t: 1700000000000, n: "abc" }),
    `POST\n/v1/tools/agents.update?x=1\n${hash}\n1700000000000\nabc`);
  const empty = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array())).toString("base64url");
  assert.equal(await proofMessage({ method: "GET", path: "/v1/events/stream", t: 1, n: "n" }), `GET\n/v1/events/stream\n${empty}\n1\nn`);
  assert.equal(pathOf(`${BOX}/v1/events/stream?type=*&since=latest`), "/v1/events/stream?type=*&since=latest");
  assert.equal(pathOf(`${BOX}/v1/tools/${encodeURIComponent("gate.approve")}`), "/v1/tools/gate.approve");
});

test("person: a proof verifies with crypto.subtle.verify over the same message (P1363)", { skip: !strip }, async () => {
  const { newKey, proof, proofMessage, fromB64url, publicJwk } = await load();
  const k = await newKey();
  assert.equal(k.privateKey.extractable, false, "the private half cannot leave");
  const url = `${BOX}/v1/tools/threads.send`;
  const body = '{"thread":"juno","text":"hi"}';
  const h = await proof(k.privateKey, { method: "POST", url, body, now: 1700000000123, nonce: "n0nce_n0nce" });
  const m = /^t=(\d+) n=([A-Za-z0-9_-]+) sig=([A-Za-z0-9_-]+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[1], "1700000000123");
  assert.equal(m[2], "n0nce_n0nce");
  const sig = fromB64url(m[3]);
  assert.equal(sig.length, 64, "raw r||s, not DER");
  const msg = await proofMessage({ method: "POST", path: "/v1/tools/threads.send", body, t: m[1], n: m[2] });
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, sig, enc.encode(msg));
  assert.equal(ok, true);
  // The box verifies with the JWK the app sent, through node:crypto in P1363 mode.
  const { createPublicKey, verify } = await import("node:crypto");
  const jwk = await publicJwk(k.publicKey);
  assert.deepEqual(Object.keys(jwk).sort(), ["crv", "kty", "x", "y"]);
  const pub = createPublicKey({ key: jwk, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(msg), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig)), true);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, sig, enc.encode(msg + "x")), false);
});

test("person: the code trades for a token, then requests carry it and a proof", { skip: !strip }, async () => {
  const { personSession, memorySlot } = await load();
  /** @type {any[]} */ const posts = [];
  const s = personSession({
    box: BOX + "/",
    stores: { key: memorySlot(), token: memorySlot() },
    signIn() {},
    fetch: /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => { posts.push({ u, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: { token: "abcdefgh.0123456789abcdefghij", id: "abcdefgh" } })); }),
  });
  assert.deepEqual(await s.headers("POST", `${BOX}/v1/tools/x`, "{}"), {}, "nothing before signing in");
  assert.deepEqual(await s.exchange("the-code", "the-verifier"), { ok: true });
  assert.equal(posts[0].u, `${BOX}/v1/person/token`);
  assert.equal(posts[0].body.code, "the-code");
  assert.equal(posts[0].body.verifier, "the-verifier");
  assert.equal(posts[0].body.key.kty, "EC");
  assert.equal(posts[0].body.key.d, undefined, "only the public half");
  const h = await s.headers("POST", `${BOX}/v1/tools/x`, "{}");
  assert.equal(h.authorization, "Vyre abcdefgh.0123456789abcdefghij");
  assert.match(h["x-vyre-proof"], /^t=\d+ n=[A-Za-z0-9_-]{22} sig=[A-Za-z0-9_-]{86}$/);
  const again = await s.headers("POST", `${BOX}/v1/tools/x`, "{}");
  assert.notEqual(again["x-vyre-proof"], h["x-vyre-proof"], "a fresh nonce every request");
});

test("person: a refused trade stores nothing", { skip: !strip }, async () => {
  const { personSession, memorySlot } = await load();
  const s = personSession({ box: BOX, stores: { key: memorySlot(), token: memorySlot() }, signIn() {},
    fetch: /** @type {any} */ (async () => new Response(JSON.stringify({ error: { code: "denied", message: "that sign-in code is used or expired" } }), { status: 403 })) });
  const r = await s.exchange("old", "v");
  assert.equal(r.ok, false);
  assert.equal(/** @type {any} */ (r).code, "denied");
  assert.equal(await s.signedIn(), false);
});

test("person: a 401 person_session_required clears the token and signs in; the write stays queued", { skip: !strip }, async () => {
  const { personSession, memorySlot } = await load();
  const { createClient } = await import("../api/client.ts");
  const token = memorySlot("abcdefgh.0123456789abcdefghij");
  let signIns = 0;
  const person = personSession({ box: BOX, stores: { key: memorySlot(), token }, signIn: () => { signIns++; } });
  /** @type {any[]} */ const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => {
    seen.push({ u: String(u), headers: init.headers });
    return new Response(JSON.stringify({ error: { code: "person_session_required", message: "the session has lapsed; sign in again" } }), { status: 401 });
  });
  let uiSignIn = 0;
  try {
    const c = await createClient({
      base: BOX, open: async () => ({ status: 200, chunks: (async function* () {})() }), caller, outboxStore: memoryStore(),
      auth: person, onSignIn: () => { uiSignIn++; }, backoff: () => backoff({ min: 60_000, max: 60_000 }),
    });
    const r = await c.call("agents.update", { name: "kit", description: "x" });
    assert.equal(r.error?.code, "person_session_required");
    assert.equal(seen[0].headers.authorization, "Vyre abcdefgh.0123456789abcdefghij", "the lapsed token was sent");
    assert.equal(await token.load(), null, "the token is gone");
    assert.equal(await person.signedIn(), false);
    assert.equal(signIns, 1);
    assert.equal(uiSignIn, 1);

    await c.send("threads.answer", { thread: "juno", answer: "yes" });
    await until(() => c.pending[0]?.state === "waiting");
    assert.equal(c.pending.length, 1, "the write waits for the sign-in, it is not dropped");
    assert.equal(seen[1].headers.authorization, undefined, "no token, no header");
    c.stop();
  } finally { globalThis.fetch = real; }
});

test("person: a relay base with a route prefix still signs /v1/tools/x?y", { skip: !strip }, async () => {
  const { boxPath, newKey, proofWith, proofMessage, fromB64url, personSession, memorySlot } = await load();
  const RELAY = "https://relay.example.net/abcdefghijklmnopqrstuvwxyz";
  assert.equal(boxPath(`${RELAY}/v1/tools/x?y`, RELAY), "/v1/tools/x?y");
  assert.equal(boxPath(`${RELAY}/v1/tools/x?y`, RELAY + "/"), "/v1/tools/x?y");
  assert.equal(boxPath("/v1/tools/x?y"), "/v1/tools/x?y", "a path is already the box's");
  assert.equal(boxPath(`${BOX}/v1/tools/x?y`), "/v1/tools/x?y");
  assert.equal(boxPath(`${RELAY}xyz/v1/tools/x`, RELAY), "/abcdefghijklmnopqrstuvwxyzxyz/v1/tools/x", "only a whole prefix is stripped");
  const k = await newKey();
  const check = async (/** @type {string} */ h) => {
    const m = /^t=(\d+) n=([A-Za-z0-9_-]+) sig=([A-Za-z0-9_-]+)$/.exec(h);
    assert.ok(m, h);
    const msg = await proofMessage({ method: "POST", path: "/v1/tools/x?y", body: "{}", t: m[1], n: m[2] });
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, fromB64url(m[3]), enc.encode(msg));
  };
  const sign = async (/** @type {string} */ m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, enc.encode(m)));
  assert.equal(await check(await proofWith(sign, { method: "POST", url: `${RELAY}/v1/tools/x?y`, base: RELAY, body: "{}" })), true);
  const s = personSession({ box: RELAY, stores: { key: memorySlot(k), token: memorySlot("tok12345.secretsecretsecret12") }, signIn() {} });
  assert.equal(await check((await s.headers("POST", `${RELAY}/v1/tools/x?y`, "{}"))["x-vyre-proof"]), true, "a full relay URL");
  assert.equal(await check((await s.headers("POST", "/v1/tools/x?y", "{}"))["x-vyre-proof"]), true, "the box-relative path client.ts passes");
});

test("person: spkiFromXY is the SPKI DER WebCrypto exports for the same P-256 key", { skip: !strip }, async () => {
  const { spkiFromXY, newKey, publicJwk, b64url } = await load();
  const k = await newKey();
  const { x, y } = await publicJwk(k.publicKey);
  assert.equal(spkiFromXY(x, y), b64url(await crypto.subtle.exportKey("spki", k.publicKey)));
  assert.throws(() => spkiFromXY("AAAA", y));
});
