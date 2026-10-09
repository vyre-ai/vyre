// @ts-check
// The phone's signer path in person.ts, in Node with no DOM: DER to P1363 on hand-built vectors,
// a node:crypto DER signature converted and checked by crypto.subtle.verify, the plain SHA-256
// Hermes uses, the JWK from x and y, a session over a DER signer (as the native module is), and
// the HUMAN_ONLY mirror against the box's own list. No native module, no app packages.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./person.ts");
const BOX = "https://juniper.example.ts.net";
const enc = new TextEncoder();

/** @param {number} n @param {number} fill */
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
/** A DER SEQUENCE of two INTEGERs with the given content bytes, lengths as given. @param {Uint8Array} r @param {Uint8Array} s */
function der(r, s) {
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

test("derToP1363: a 33-byte r (leading 0x00 before a high bit) and a 31-byte s", { skip: !strip }, async () => {
  const { derToP1363 } = await load();
  const r = new Uint8Array([0x00, ...bytes(32, 0x80)]);
  const s = bytes(31, 0x11);
  const out = derToP1363(der(r, s));
  assert.equal(out.length, 64);
  assert.deepEqual(out.subarray(0, 32), bytes(32, 0x80), "the sign byte is dropped");
  assert.equal(out[32], 0, "a short s is left-padded");
  assert.deepEqual(out.subarray(33), bytes(31, 0x11));
});

test("derToP1363: two plain 32-byte values, tiny values, and zero", { skip: !strip }, async () => {
  const { derToP1363 } = await load();
  const r = bytes(32, 0x42), s = bytes(32, 0x7f);
  assert.deepEqual(derToP1363(der(r, s)), new Uint8Array([...r, ...s]));
  const tiny = derToP1363(der(new Uint8Array([0x01]), new Uint8Array([0x00, 0xff])));
  const want = new Uint8Array(64);
  want[31] = 0x01;
  want[63] = 0xff;
  assert.deepEqual(tiny, want);
  assert.deepEqual(derToP1363(der(new Uint8Array([0]), new Uint8Array([0]))), new Uint8Array(64));
  // Redundant leading zeros (not minimal DER) still land right.
  assert.deepEqual(derToP1363(der(new Uint8Array([0, 0, 5]), new Uint8Array([6]))).subarray(31, 33), new Uint8Array([5, 0]));
});

test("derToP1363: refuses what is not a P-256 DER signature", { skip: !strip }, async () => {
  const { derToP1363 } = await load();
  const good = der(bytes(32, 1), bytes(32, 2));
  const bad = [
    new Uint8Array([]),
    new Uint8Array([0x31, ...good.subarray(1)]), // not a SEQUENCE
    good.subarray(0, good.length - 1), // cut short
    new Uint8Array([...good, 0x00]), // trailing byte
    der(new Uint8Array([0x00, ...bytes(33, 0x80)]), bytes(32, 1)), // r longer than 32 bytes
    der(new Uint8Array([0x80, 1]), bytes(32, 1)), // negative r
    new Uint8Array([0x30, 4, 0x04, 1, 1, 0x02]), // an OCTET STRING, not an INTEGER
  ];
  for (const b of bad) assert.throws(() => derToP1363(b), /not a DER ECDSA signature/, Buffer.from(b).toString("hex"));
});

test("derToP1363: node:crypto DER signatures verify as P1363 in crypto.subtle", { skip: !strip }, async () => {
  const { derToP1363 } = await load();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = await crypto.subtle.importKey("jwk", /** @type {any} */ (publicKey.export({ format: "jwk" })), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const seen = new Set();
  // 300 signatures: about 1 in 2 has a 33-byte r or s in DER and about 1 in 128 a short one.
  for (let i = 0; i < 300; i++) {
    const msg = enc.encode(`POST\n/v1/tools/threads.send\nhash\n${i}\nn${i}`);
    const d = new Uint8Array(nodeSign("sha256", msg, privateKey));
    seen.add(d[3]);
    const p = derToP1363(d);
    assert.equal(p.length, 64);
    assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, p, msg), true, `signature ${i}`);
    assert.equal(nodeVerify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, p), true);
  }
  assert.ok(seen.has(33) && seen.has(32), "both 32- and 33-byte r came up");
});

test("sha256: the plain SHA-256 matches node:crypto, and sha256b64url uses it without WebCrypto", { skip: !strip }, async () => {
  const { sha256, sha256b64url } = await load();
  for (let n = 0; n < 200; n++) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    assert.equal(Buffer.from(sha256(b)).toString("hex"), createHash("sha256").update(b).digest("hex"), `length ${n}`);
  }
  const text = '{"text":"héllo, 世界 👋"}';
  const want = createHash("sha256").update(text).digest("base64url");
  const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(globalThis, "crypto"));
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(globalThis.crypto, undefined);
    assert.equal(await sha256b64url(text), want, "Hermes path");
  } finally {
    Object.defineProperty(globalThis, "crypto", d);
  }
  assert.equal(await sha256b64url(text), want, "WebCrypto path");
});

test("jwkFromXY: the JWK the box takes, from base64url coordinates", { skip: !strip }, async () => {
  const { jwkFromXY } = await load();
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = /** @type {any} */ (publicKey.export({ format: "jwk" }));
  const jwk = jwkFromXY(j.x, j.y);
  assert.deepEqual(jwk, { kty: "EC", crv: "P-256", x: j.x, y: j.y });
  assert.ok(createPublicKey({ key: jwk, format: "jwk" }).asymmetricKeyType === "ec");
  assert.throws(() => jwkFromXY(j.x.slice(2), j.y), /32-byte/);
  assert.throws(() => jwkFromXY(j.x, ""), /32-byte/);
});

/** A Signer the way the phone's is: the private key signs DER, and derToP1363 converts it. */
async function derSigner() {
  const { derToP1363, jwkFromXY } = await load();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = /** @type {any} */ (publicKey.export({ format: "jwk" }));
  return {
    publicKey,
    signer: {
      publicJwk: async () => jwkFromXY(j.x, j.y),
      /** @param {string} m */
      sign: async (m) => derToP1363(new Uint8Array(nodeSign("sha256", enc.encode(m), privateKey))),
    },
  };
}

test("personSession over a DER signer: trade sends key and extras, requests carry a proof the box verifies", { skip: !strip }, async () => {
  const { personSession, memorySlot, proofMessage, fromB64url } = await load();
  const person = await derSigner();
  const human = await derSigner();
  /** @type {any[]} */ const posts = [];
  let nonces = 0;
  const s = personSession({
    box: BOX,
    stores: { token: memorySlot() },
    signer: person.signer,
    nonce: () => `n${++nonces}_nonce`,
    trade: async () => ({ human: await human.signer.publicJwk() }),
    more: async (method, url) => (url.endsWith("/gate.approve") ? { "x-vyre-presence": "device key=k ts=1 nonce=abcdefgh sig=x" } : {}),
    signIn: () => {},
    now: () => 1700000000999,
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: { token: "abcdefgh1234.secretsecretsecret1234" } }), { status: 200 });
    }),
  });
  assert.deepEqual(await s.headers("GET", `${BOX}/v1/events/stream`, ""), {}, "nothing before sign-in");
  assert.deepEqual(await s.exchange("code123", "verifier123"), { ok: true });
  assert.equal(posts[0].url, `${BOX}/v1/person/token`);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ["code", "human", "key", "verifier"]);
  assert.deepEqual(posts[0].body.key, await person.signer.publicJwk());
  assert.deepEqual(posts[0].body.human, await human.signer.publicJwk());

  const url = `${BOX}/v1/tools/threads.send`;
  const body = '{"thread":"juno","text":"hi"}';
  const h = await s.headers("POST", url, body);
  assert.equal(h.authorization, "Vyre abcdefgh1234.secretsecretsecret1234");
  assert.equal(h["x-vyre-presence"], undefined);
  const m = /^t=(\d+) n=(\S+) sig=([A-Za-z0-9_-]+)$/.exec(h["x-vyre-proof"]);
  assert.ok(m);
  assert.equal(m[1], "1700000000999");
  assert.equal(m[2], "n1_nonce", "the nonce came from the runtime's source");
  const sig = fromB64url(m[3]);
  assert.equal(sig.length, 64);
  const msg = await proofMessage({ method: "POST", path: "/v1/tools/threads.send", body, t: m[1], n: m[2] });
  // As the box does: the JWK from the trade, node:crypto, P1363.
  const pub = createPublicKey({ key: posts[0].body.key, format: "jwk" });
  assert.equal(nodeVerify("sha256", Buffer.from(msg), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig)), true);
  assert.equal((await s.headers("POST", `${BOX}/v1/tools/gate.approve`, "{}"))["x-vyre-presence"], "device key=k ts=1 nonce=abcdefgh sig=x");
});

test("personSession: a signer that fails forgets the token and signs in again, never throws", { skip: !strip }, async () => {
  const { personSession, memorySlot } = await load();
  const token = memorySlot("abcdefgh1234.secretsecretsecret1234");
  let signIns = 0;
  const s = personSession({
    box: BOX,
    stores: { token },
    signer: { publicJwk: async () => { throw new Error("gone"); }, sign: async () => { throw Object.assign(new Error("no key"), { code: "ERR_NO_KEY" }); } },
    signIn: () => void signIns++,
  });
  assert.equal(await s.signedIn(), true);
  assert.deepEqual(await s.headers("POST", `${BOX}/v1/tools/x`, "{}"), {});
  assert.equal(signIns, 1);
  assert.equal(await s.signedIn(), false);
  assert.equal(await token.load(), null);
});
