// @ts-check
// The phone's native sign-in and presence (person.ts), in Node with no native module: the token
// trade signed with the key it registers and no Origin, the biometric JWK kept apart from it, the
// input hash's canonical JSON against the box's, the device proof verified as the box does
// (node:crypto, DER), the presence session replacing prompts after keep, and its expiry.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { caller } from "../../../../core/resilience/web.js";
import { memoryStore } from "../../../../core/resilience/outbox.js";
import { backoff } from "../../../../core/resilience/backoff.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./person.ts");
const BOX = "https://juniper.example.ts.net";
const enc = new TextEncoder();
const TOKEN = "abcdefgh1234.secretsecretsecret1234";

/** A P-256 pair and a signer over it the way the module signs: DER. */
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = /** @type {any} */ (publicKey.export({ format: "jwk" }));
  return {
    publicKey,
    jwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y },
    /** DER as base64url, what vyre-signer's sign() returns. @param {string} m */
    der: async (m) => nodeSign("sha256", enc.encode(m), privateKey).toString("base64url"),
  };
}

/**
 * An independent canonical JSON, written from the box's comment ("keys sorted at every depth, no
 * spaces", undefined and functions left out of objects, null in arrays), not copied from it.
 * @param {any} v @returns {string}
 */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === "function" ? "null" : canon(x))).join(",")}]`;
  if (v !== null && typeof v === "object" && typeof v.toJSON !== "function") {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== "function").sort();
    return `{${ks.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  }
  const s = JSON.stringify(v);
  return s === undefined ? "null" : s;
}
/** @param {unknown} v */
const boxHash = (v) => createHash("sha256").update(canon(v)).digest("base64url");

test("canonical: hand-written vectors, nested objects, arrays, unicode and numbers", { skip: !strip }, async () => {
  const { canonical, inputHash } = await load();
  /** @type {[unknown, string][]} */
  const vectors = [
    [{ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }, '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}'],
    [{ "é": "世界 👋", a: 'line\nbreak "q"' }, '{"a":"line\\nbreak \\"q\\"","é":"世界 👋"}'],
    [{ n: [1.5, -0, 1e21, 0.1, 100, -3], u: undefined, f: [undefined, () => 1], g: () => 1 }, '{"f":[null,null],"n":[1.5,0,1e+21,0.1,100,-3]}'],
  ];
  for (const [v, want] of vectors) {
    assert.equal(canonical(v), want);
    assert.equal(canon(v), want, "the independent version agrees");
    assert.equal(await inputHash(v), createHash("sha256").update(want, "utf8").digest("base64url"));
  }
  const more = [{}, [], "s", 0, null, true, { B: 1, a: 2, _: 3, "10": 4, "9": 5 }, [[{ b: [{ d: 1, c: 2 }] }]], { id: "g5", decision: "approve", note: "ok ✓" }];
  for (const v of more) assert.equal(canonical(v), canon(v), JSON.stringify(v));
  // The box's own function, where its code is beside this app.
  let box;
  try {
    box = (await import("../../../../core/presence/index.js")).canonical;
  } catch {}
  if (box) for (const v of [...vectors.map((x) => x[0]), ...more]) assert.equal(canonical(v), box(v), JSON.stringify(v));
});

test("token trade: no Origin, signed by the key it registers, human apart from key, human.key kept", { skip: !strip }, async () => {
  const { personSession, memorySlot, jwkFromXY, derToP1363, fromB64url } = await load();
  const person = pair();
  const human = pair();
  /** @type {any[]} */ const posts = [];
  /** @type {any} */ let traded = null;
  const s = personSession({
    box: BOX,
    stores: { token: memorySlot() },
    signer: {
      publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y),
      sign: async (m) => derToP1363(fromB64url(await person.der(m))),
    },
    nonce: () => "tradeNonce0001",
    now: () => 1_700_000_000_123,
    signTrade: true,
    trade: async () => ({ human: human.jwk }),
    traded: (d) => void (traded = d),
    signIn: () => {},
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      posts.push({ url, init });
      return new Response(JSON.stringify({ data: { token: TOKEN, expires: 1, id: "abcdefgh1234", human: { key: "fp-of-human-key-000001" } } }), { status: 200 });
    }),
  });
  assert.deepEqual(await s.exchange("code123", "verifier123"), { ok: true });
  const { url, init } = posts[0];
  assert.equal(url, `${BOX}/v1/person/token`);
  const lower = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lower.origin, undefined, "a native trade sends no Origin");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ["code", "human", "key", "verifier"]);
  assert.deepEqual(body.key, person.jwk);
  assert.deepEqual(body.human, human.jwk);
  assert.notEqual(body.human.x, body.key.x);
  assert.equal(body.human.d, undefined);
  // As the box's exchange() checks it: signed(), the registered JWK, P1363.
  const m = /^t=(\d+) n=([A-Za-z0-9_-]+) sig=([A-Za-z0-9_-]+)$/.exec(lower["x-vyre-proof"]);
  assert.ok(m, lower["x-vyre-proof"]);
  assert.equal(m[1], "1700000000123");
  const msg = `POST\n/v1/person/token\n${createHash("sha256").update(init.body).digest("base64url")}\n${m[1]}\n${m[2]}`;
  const pub = createPublicKey({ key: body.key, format: "jwk" });
  assert.equal(nodeVerify("sha256", Buffer.from(msg), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")), true);
  assert.equal(traded.human.key, "fp-of-human-key-000001");
});

test("token trade: a human JWK equal to key, or carrying d, is left out", { skip: !strip }, async () => {
  const { personSession, memorySlot, jwkFromXY, derToP1363, fromB64url } = await load();
  const person = pair();
  for (const bad of [person.jwk, { ...pair().jwk, d: "secret" }]) {
    /** @type {any[]} */ const posts = [];
    const s = personSession({
      box: BOX,
      stores: { token: memorySlot() },
      signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y), sign: async (m) => derToP1363(fromB64url(await person.der(m))) },
      signTrade: true,
      trade: async () => ({ human: bad }),
      signIn: () => {},
      fetch: /** @type {any} */ (async (/** @type {string} */ _u, /** @type {any} */ init) => {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ data: { token: TOKEN } }), { status: 200 });
      }),
    });
    await s.exchange("c", "v");
    assert.equal(posts[0].human, undefined);
  }
});

test("keyIdFromXY: the box's fingerprint of the key's SPKI DER", { skip: !strip }, async () => {
  const { keyIdFromXY } = await load();
  const k = pair();
  const spki = k.publicKey.export({ format: "der", type: "spki" });
  assert.equal(keyIdFromXY(k.jwk.x, k.jwk.y), createHash("sha256").update(spki).digest("base64url").slice(0, 22));
});

/** A devicePresence over a node key, counting prompts, on a settable clock. */
async function device(o = {}) {
  const { devicePresence, memorySlot } = await load();
  const k = pair();
  const clock = { t: 1_700_000_000_000 };
  let n = 0;
  /** @type {string[]} */ const prompts = [];
  const store = memorySlot();
  const p = devicePresence({
    keyId: async () => "devkey0000000000000001",
    sign: async (m, tool) => {
      prompts.push(tool);
      return k.der(m);
    },
    nonce: () => `nonce${String(++n).padStart(6, "0")}`,
    now: () => clock.t,
    store,
    ...o,
  });
  return { p, k, clock, prompts, store };
}

/** Check a device header as core/presence/index.js verify() does for method device. */
function verifyDevice(/** @type {string} */ h, /** @type {string} */ tool, /** @type {unknown} */ input, /** @type {any} */ publicKey) {
  const m = /^device key=(\S+) ts=(\d{1,16}) nonce=([A-Za-z0-9_-]{8,128}) sig=([A-Za-z0-9_-]+)$/.exec(h);
  assert.ok(m, h);
  const msg = Buffer.from(`vyre-presence-v1\n${tool}\n${boxHash(input)}\n${m[2]}\n${m[3]}`);
  assert.equal(nodeVerify("sha256", msg, { key: publicKey, dsaEncoding: "der" }, Buffer.from(m[4], "base64url")), true, "DER over the right message");
  return { key: m[1], ts: m[2], nonce: m[3] };
}

