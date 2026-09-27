// @ts-check
// The phone's native sign-in and presence (person.ts), in Node with no native module: the token
// trade signed with the key it registers and no Origin, the biometric JWK kept apart from it, the
// input hash's canonical JSON against the box's, the device proof verified as the box does
// (node:crypto, DER), the presence session replacing prompts after keep, and its expiry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { caller } from "../../../../core/resilience/web.js";
import { memoryStore } from "../../../../core/resilience/outbox.js";
import { backoff } from "../../../../core/resilience/backoff.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./person.ts");
const BOX = "https://harlow.example.ts.net";
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

test("SESSIONABLE and NARROWABLE mirror the box's lists", { skip: !strip }, async () => {
  const { SESSIONABLE, NARROWABLE } = await load();
  let box;
  try {
    box = await import("../../../../core/presence/index.js");
  } catch {
    return;
  }
  assert.deepEqual([...SESSIONABLE].sort(), [...box.SESSIONABLE].sort());
  if (box.NARROWABLE) assert.deepEqual([...NARROWABLE].sort(), [...box.NARROWABLE].sort());
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

test("presence: a HUMAN_ONLY call carries a device proof the box verifies, with keep", { skip: !strip }, async () => {
  const { p, k, prompts } = await device();
  const input = { item: "bank", field: "password", note: "héllo ✓", n: [1, 2.5] };
  const h = await p.headers("vault.reveal", JSON.stringify(input));
  assert.equal(h["x-vyre-presence-keep"], "1");
  const f = verifyDevice(h["x-vyre-presence"], "vault.reveal", input, k.publicKey);
  assert.equal(f.key, "devkey0000000000000001");
  assert.equal(f.ts, "1700000000000");
  assert.deepEqual(prompts, ["vault.reveal"]);
  // Key order in the body does not matter: the hash is over the canonical input.
  const again = await p.headers("vault.reveal", '{"n":[1,2.5],"note":"héllo ✓","field":"password","item":"bank"}');
  verifyDevice(again["x-vyre-presence"], "vault.reveal", input, k.publicKey);
  // Anything not HUMAN_ONLY goes with nothing and no prompt.
  assert.deepEqual(await p.headers("threads.send", '{"text":"hi"}'), {});
  assert.equal(prompts.length, 2);
});

test("presence: after keep, the session replaces device proofs on sessionable calls, no prompt", { skip: !strip }, async () => {
  const { p, clock, prompts, store } = await device();
  await p.keep(`session id=sess0000000001 secret=${"s".repeat(43)} expires=${clock.t + 30 * 60_000}`);
  assert.ok(await store.load(), "kept in the store");
  for (const tool of ["gate.approve", "vault.reveal", "vault.copy", "vault.totp"]) {
    const h = await p.headers(tool, '{"id":"g1"}');
    assert.deepEqual(h, { "x-vyre-presence": `session id=sess0000000001 secret=${"s".repeat(43)}` }, tool);
  }
  assert.deepEqual(prompts, []);
  // Not sessionable: its own proof still.
  const put = await p.headers("vault.put", '{"item":"x"}');
  assert.match(put["x-vyre-presence"], /^device /);
  assert.deepEqual(prompts, ["vault.put"]);
  // A malformed or already expired header is not kept.
  const other = await device();
  await other.p.keep("session id=x secret=y expires=1");
  await other.p.keep(`session id=sess0000000002 secret=${"s".repeat(43)} expires=${other.clock.t - 1}`);
  assert.equal(await other.p.session(), null);
});

test("presence: an expired session falls back to a prompt", { skip: !strip }, async () => {
  const { p, clock, prompts } = await device();
  await p.keep(`session id=sess0000000001 secret=${"s".repeat(43)} expires=${clock.t + 30 * 60_000}`);
  assert.match((await p.headers("vault.reveal", "{}"))["x-vyre-presence"], /^session /);
  clock.t += 30 * 60_000;
  const h = await p.headers("vault.reveal", "{}");
  assert.match(h["x-vyre-presence"], /^device /);
  assert.equal(h["x-vyre-presence-keep"], "1");
  assert.deepEqual(prompts, ["vault.reveal"]);
});

test("presence: a session the box refuses goes again with its own proof", { skip: !strip }, async () => {
  const { p, clock, prompts } = await device();
  await p.keep(`session id=sess0000000001 secret=${"s".repeat(43)} expires=${clock.t + 30 * 60_000}`);
  const body = '{"item":"always"}';
  await p.headers("vault.reveal", body);
  assert.equal(p.answered("vault.reveal", body, { error: { code: "presence_required", message: "this item needs its own proof every time" } }), true);
  assert.match((await p.headers("vault.reveal", body))["x-vyre-presence"], /^device /);
  assert.equal(p.answered("vault.reveal", body, { data: {} }), false);
  // Other items still ride the session.
  assert.match((await p.headers("vault.reveal", '{"item":"b"}'))["x-vyre-presence"], /^session /);
  // A session the box ended is dropped.
  await p.headers("vault.copy", "{}");
  assert.equal(p.answered("vault.copy", "{}", { error: { code: "presence_required", message: "no such session, or it ended" } }), true);
  assert.equal(await p.session(), null);
  assert.deepEqual(prompts, ["vault.reveal"]);
});

test("presence: gate.approve asks only when the box says so (no-nag), and a closed prompt is not retried", { skip: !strip }, async () => {
  const { p, prompts } = await device();
  const body = '{"id":"g1"}';
  assert.deepEqual(await p.headers("gate.approve", body), {}, "no prompt first");
  assert.equal(p.answered("gate.approve", body, { data: { approved: true } }), false);
  assert.deepEqual(prompts, []);
  const send = '{"id":"g2"}';
  await p.headers("gate.approve", send);
  assert.equal(p.answered("gate.approve", send, { error: { code: "presence_required", message: "gate.approve needs a person" } }), true);
  const h = await p.headers("gate.approve", send);
  assert.match(h["x-vyre-presence"], /^device /);
  assert.deepEqual(prompts, ["gate.approve"]);
  assert.equal(p.answered("gate.approve", send, { error: { code: "presence_required", message: "the device signature does not check out" } }), false, "one retry, never a loop");

  const closed = await device({ sign: async () => { throw Object.assign(new Error("closed"), { code: "ERR_CANCELED" }); } });
  assert.deepEqual(await closed.p.headers("vault.reveal", "{}"), {});
  assert.equal(closed.p.answered("vault.reveal", "{}", { error: { code: "presence_required", message: "vault.reveal needs a person" } }), false);
});

test("client + person session: a presence refusal goes once more with the proof, then the session rides", { skip: !strip }, async () => {
  const { personSession, memorySlot, jwkFromXY, derToP1363, fromB64url, devicePresence, toolOf } = await load();
  const { createClient } = await import("../api/client.ts");
  const person = pair();
  const human = pair();
  let n = 0;
  const presence = devicePresence({ keyId: async () => "devkey0000000000000001", sign: (m) => human.der(m), nonce: () => `nonce${++n}xyz` });
  const s = personSession({
    box: BOX,
    stores: { token: memorySlot(TOKEN) },
    signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y), sign: async (m) => derToP1363(fromB64url(await person.der(m))) },
    signIn: () => {},
    more: async (method, url, body) => { const t = toolOf(url); return t && method === "POST" ? presence.headers(t, body) : {}; },
    answered: (method, url, body, r) => { const t = toolOf(url); return t ? presence.answered(t, body, r) : false; },
  });
  /** @type {any[]} */ const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push(init.headers);
    const p = init.headers["x-vyre-presence"] ?? "";
    if (p.startsWith("device ")) {
      await presence.keep(`session id=sess0000000009 secret=${"z".repeat(43)} expires=${Date.now() + 30 * 60_000}`);
      return new Response(JSON.stringify({ data: { approved: true } }), { status: 200 });
    }
    if (p.startsWith("session ")) return new Response(JSON.stringify({ data: { approved: true } }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "presence_required", message: "gate.approve needs a person" } }), { status: 403 });
  });
  try {
    let k = 0;
    const c = await createClient({ base: BOX, open: async () => ({ status: 200, chunks: (async function* () {})() }), caller, outboxStore: memoryStore(),
      auth: s, newKey: () => `key-${++k}`, backoff: () => backoff({ min: 1, max: 1 }) });
    const { answered } = await c.send("gate.approve", { id: "g7" });
    assert.deepEqual(await answered, { data: { approved: true } });
    assert.equal(seen.length, 2, "one refusal, one retry");
    assert.equal(seen[0]["x-vyre-presence"], undefined);
    assert.equal(seen[1]["idempotency-key"], seen[0]["idempotency-key"], "the same write");
    verifyDevice(seen[1]["x-vyre-presence"], "gate.approve", { id: "g7" }, human.publicKey);
    assert.ok(seen[1].authorization && seen[1]["x-vyre-proof"], "the person session rides too");
    const second = await c.send("gate.approve", { id: "g8" });
    assert.deepEqual(await second.answered, { data: { approved: true } });
    assert.equal(seen.length, 3);
    assert.equal(seen[2]["x-vyre-presence"], `session id=sess0000000009 secret=${"z".repeat(43)}`);
    c.stop();
  } finally {
    globalThis.fetch = real;
  }
});

test("presence: one session per path (the box pins it to the tailnet node or the relay device)", { skip: !strip }, async () => {
  let at = "direct";
  const { p, clock, prompts } = await device({ path: () => at });
  await p.keep(`session id=sessdirect0001 secret=${"d".repeat(43)} expires=${clock.t + 30 * 60_000}`);
  assert.match((await p.headers("vault.reveal", '{"item":"a"}'))["x-vyre-presence"], /^session id=sessdirect0001 /);
  at = "relay";
  assert.equal(await p.session(), null, "the direct session does not ride the relay");
  assert.match((await p.headers("vault.reveal", '{"item":"b"}'))["x-vyre-presence"] ?? "", /^$|^device /);
  await p.keep(`session id=sessrelay00001 secret=${"r".repeat(43)} expires=${clock.t + 30 * 60_000}`);
  at = "direct";
  assert.equal((await p.session())?.id, "sessdirect0001", "each path keeps its own");
  at = "relay";
  assert.equal((await p.session())?.id, "sessrelay00001");
  await p.forget();
  at = "direct";
  assert.equal(await p.session(), null, "signing out forgets every path");
  assert.ok(prompts.length <= 1);
});
