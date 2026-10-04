// @ts-check
// The person session per path (person.ts): a token for the direct path (the PKCE hop) and one for
// the relay (presence.person.start, signed by the biometric key), never crossed; the relay sign-in
// request checked as the box checks it (node:crypto, DER, inputHash of {key}); sign-out forgetting
// both; a 401 on the relay starting the device flow, not the browser; a closed prompt not shown
// again on its own for 60 s. Node only, no native module, no network.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./person.ts");
const BOX = "https://harlow.example.ts.net";
const enc = new TextEncoder();
const DIRECT = "directtok001.directsecretdirectsecret01";
const RELAY = "relaytoken01.relaysecretrelaysecret0001";

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

/** Sorted-key JSON with no spaces, written here from the box's description, not copied. @param {any} v @returns {string} */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** A person session keyed per path over a settable path, the person key a node pair. */
async function session(o = {}) {
  const { personSession, memorySlot, jwkFromXY, derToP1363, fromB64url } = await load();
  const person = pair();
  const at = { path: "direct" };
  const store = memorySlot(/** @type {any} */ (o).stored ?? null);
  /** @type {any[]} */ const sent = [];
  let signIns = 0;
  const s = personSession({
    box: BOX,
    stores: { token: store },
    signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y), sign: async (m) => derToP1363(fromB64url(await person.der(m))) },
    path: () => at.path,
    send: async (path, init) => {
      sent.push({ path, init, at: at.path });
      return { status: 200 };
    },
    signIn: () => void signIns++,
    fetch: /** @type {any} */ (async () => new Response(JSON.stringify({ data: { token: DIRECT } }), { status: 200 })),
    ...o,
  });
  return { s, at, store, sent, person, signIns: () => signIns };
}

/** The Vyre token a request's headers carry, or null. @param {Record<string, string>} h */
const tokenOf = (h) => (h.authorization ? h.authorization.replace(/^Vyre /, "") : null);

test("relay sign-in: the body is {key}, the device header verifies as the box checks it", { skip: !strip }, async () => {
  const { devicePersonStart, jwkFromXY, keyIdFromXY } = await load();
  const person = pair();
  const human = pair();
  const keyId = keyIdFromXY(human.jwk.x, human.jwk.y);
  /** @type {any[]} */ const posts = [];
  const r = await devicePersonStart({
    signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y) },
    keyId: async () => keyId,
    sign: (m) => human.der(m),
    nonce: () => "relayNonce000001",
    now: () => 1_700_000_000_456,
    send: async (path, init) => {
      posts.push({ path, init });
      return { status: 200, json: async () => ({ data: { kind: "bearer", id: "relaytoken01", token: RELAY, expires: 1_700_086_400_000 } }) };
    },
  });
  assert.deepEqual(r, { ok: true, token: RELAY, expires: 1_700_086_400_000 });
  assert.equal(posts.length, 1);
  const { path, init } = posts[0];
  assert.equal(path, "/v1/tools/presence.person.start");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, undefined, "no token yet");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["key"]);
  assert.deepEqual(body.key, person.jwk, "the person key, not the biometric one");
  const m = /^device key=(\S+) ts=(\d{1,16}) nonce=([A-Za-z0-9_-]{8,128}) sig=([A-Za-z0-9_-]+)$/.exec(init.headers["x-vyre-presence"]);
  assert.ok(m, init.headers["x-vyre-presence"]);
  // The key id is the box's fingerprint of the biometric key's SPKI DER, the one pairing enrolled.
  const spki = human.publicKey.export({ format: "der", type: "spki" });
  assert.equal(m[1], createHash("sha256").update(spki).digest("base64url").slice(0, 22));
  assert.equal(m[2], "1700000000456");
  assert.equal(m[3], "relayNonce000001");
  const hash = createHash("sha256").update(canon({ key: body.key })).digest("base64url");
  const msg = Buffer.from(`vyre-presence-v1\npresence.person.start\n${hash}\n${m[2]}\n${m[3]}`);
  assert.equal(nodeVerify("sha256", msg, { key: human.publicKey, dsaEncoding: "der" }, Buffer.from(m[4], "base64url")), true, "DER over the right message");
  assert.equal(nodeVerify("sha256", msg, { key: person.publicKey, dsaEncoding: "der" }, Buffer.from(m[4], "base64url")), false, "not the person key");
  assert.equal(init.headers["x-vyre-presence-keep"], undefined);

  // A closed prompt sends nothing; a refusal comes back as the box's error; no key, no request.
  /** @type {any[]} */ const none = [];
  const base = { signer: { publicJwk: async () => person.jwk }, nonce: () => "n0000000001", send: /** @type {any} */ (async (/** @type {any} */ p) => void none.push(p)) };
  const closed = await devicePersonStart({ ...base, keyId: async () => keyId, sign: async () => { throw new Error("closed"); } });
  assert.equal(closed.ok ? "" : closed.code, "declined");
  const nokey = await devicePersonStart({ ...base, keyId: async () => null, sign: human.der });
  assert.equal(nokey.ok ? "" : nokey.code, "no_key");
  assert.equal(none.length, 0);
  const refused = await devicePersonStart({
    ...base, keyId: async () => keyId, sign: human.der,
    send: async () => ({ status: 403, json: async () => ({ error: { code: "denied", message: "only method device is accepted over the relay" } }) }),
  });
  assert.deepEqual(refused, { ok: false, code: "denied", message: "only method device is accepted over the relay" });
});

test("tokens per path: the direct token never rides the relay, nor the relay's the direct path", { skip: !strip }, async () => {
  const { s, at, store } = await session();
  assert.deepEqual(await s.exchange("code1", "verifier1"), { ok: true });
  assert.equal(tokenOf(await s.headers("POST", "/v1/tools/x", "{}")), DIRECT);
  at.path = "relay";
  assert.deepEqual(await s.headers("POST", "/v1/tools/x", "{}"), {}, "no relay token yet");
  assert.equal(await s.signedIn(), false);
  assert.equal(await s.adopt(RELAY), true);
  assert.equal(tokenOf(await s.headers("POST", "/v1/tools/x", "{}")), RELAY);
  at.path = "direct";
  assert.equal(tokenOf(await s.headers("POST", "/v1/tools/x", "{}")), DIRECT);
  assert.deepEqual(JSON.parse(String(await store.load())), { direct: DIRECT, relay: RELAY }, "one slot, a JSON map");
  // A 401 on one path forgets that path's token only.
  at.path = "relay";
  s.required();
  assert.deepEqual(await s.headers("GET", "/v1/events", ""), {});
  at.path = "direct";
  assert.equal(tokenOf(await s.headers("GET", "/v1/events", "")), DIRECT);
  assert.deepEqual(JSON.parse(String(await store.load())), { direct: DIRECT });
  // A PKCE trade finished while the relay is current is still the direct path's token.
  const two = await session();
  two.at.path = "relay";
  await two.s.exchange("code2", "verifier2");
  assert.equal(await two.s.signedIn(), false);
  two.at.path = "direct";
  assert.equal(await two.s.signedIn(), true);
  // Nothing that is not a token is kept.
  assert.equal(await two.s.adopt("not a token"), false);
});

test("tokens per path: an old single token becomes the direct one; a bad slot reads as none", { skip: !strip }, async () => {
  const { readTokens } = await load();
  const { s, at, store } = await session({ stored: DIRECT });
  assert.equal(tokenOf(await s.headers("POST", "/v1/tools/x", "{}")), DIRECT);
  at.path = "relay";
  assert.deepEqual(await s.headers("POST", "/v1/tools/x", "{}"), {}, "the old token is not the relay's");
  await s.adopt(RELAY);
  assert.deepEqual(JSON.parse(String(await store.load())), { direct: DIRECT, relay: RELAY });
  assert.deepEqual(readTokens("{not json"), {});
  assert.deepEqual(readTokens(JSON.stringify({ direct: "short", relay: RELAY, x: 5 })), { relay: RELAY });
  assert.deepEqual(readTokens(null), {});
});

test("sign-out forgets both paths and ends the current one over the transport", { skip: !strip }, async () => {
  const { s, at, store, sent } = await session();
  await s.exchange("c", "v");
  at.path = "relay";
  await s.adopt(RELAY);
  await s.end();
  assert.equal(await store.load(), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/v1/person/end");
  assert.equal(tokenOf(sent[0].init.headers), RELAY, "ended with the current path's token");
  assert.equal(await s.signedIn(), false);
  at.path = "direct";
  assert.equal(await s.signedIn(), false);
});

/** A person session and pathSignIn wired as nativePerson wires them, with counted hops and prompts. */
async function wired(/** @type {{ sign?: (m: string) => Promise<string> }} */ o = {}) {
  const { personSession, memorySlot, jwkFromXY, derToP1363, fromB64url, devicePersonStart, pathSignIn, keyIdFromXY } = await load();
  const person = pair();
  const human = pair();
  const at = { path: "relay" };
  const clock = { t: 1_700_000_000_000 };
  const count = { pkce: 0, prompts: 0, starts: 0 };
  /** @type {boolean[]} */ const signedIn = [];
  /** @type {(o?: { force?: boolean }) => Promise<boolean>} */
  let run = async () => false;
  /** @type {Promise<boolean> | null} */ let last = null;
  const s = personSession({
    box: BOX,
    stores: { token: memorySlot() },
    signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y), sign: async (m) => derToP1363(fromB64url(await person.der(m))) },
    path: () => at.path,
    now: () => clock.t,
    signIn: () => void (last = run()),
  });
  run = pathSignIn({
    path: () => at.path,
    direct: async () => {
      count.pkce++;
      return false;
    },
    relay: () =>
      devicePersonStart({
        signer: { publicJwk: async () => jwkFromXY(person.jwk.x, person.jwk.y) },
        keyId: async () => keyIdFromXY(human.jwk.x, human.jwk.y),
        sign: async (m) => {
          count.prompts++;
          return o.sign ? o.sign(m) : human.der(m);
        },
        nonce: () => "nonce00000001",
        now: () => clock.t,
        send: async () => {
          count.starts++;
          return { status: 200, json: async () => ({ data: { kind: "bearer", id: "relaytoken01", token: RELAY, expires: clock.t + 86_400_000 } }) };
        },
      }),
    session: s,
    onSignedIn: (ok) => void signedIn.push(ok),
    now: () => clock.t,
  });
  return { s, at, clock, count, signedIn, run, settle: async () => { await last; } };
}

test("a 401 person_session_required on the relay signs in with the device flow, not the browser", { skip: !strip }, async () => {
  const w = await wired();
  w.s.required();
  await w.settle();
  assert.deepEqual(w.count, { pkce: 0, prompts: 1, starts: 1 });
  assert.deepEqual(w.signedIn, [true]);
  assert.equal(tokenOf(await w.s.headers("POST", "/v1/tools/x", "{}")), RELAY);
  w.at.path = "direct";
  assert.deepEqual(await w.s.headers("POST", "/v1/tools/x", "{}"), {}, "the relay token stays on the relay");
  // On the direct path the same 401 goes to the browser hop, with no prompt.
  w.s.required();
  await w.settle();
  assert.deepEqual(w.count, { pkce: 1, prompts: 1, starts: 1 });
  // Several asks at once share one prompt; a live relay token asks for none.
  const x = await wired();
  await Promise.all([x.run(), x.run(), x.run()]);
  assert.equal(x.count.prompts, 1);
  assert.equal(await x.run(), true);
  assert.equal(x.count.prompts, 1, "signed in already: no prompt");
});

test("a closed prompt on the relay is not shown again on its own for 60 s", { skip: !strip }, async () => {
  const { DECLINED_MS } = await load();
  assert.equal(DECLINED_MS, 60_000);
  let close = true;
  const human = pair();
  const w = await wired({ sign: async (m) => { if (close) throw Object.assign(new Error("closed"), { code: "ERR_CANCELED" }); return human.der(m); } });
  w.s.required();
  await w.settle();
  assert.deepEqual(w.count, { pkce: 0, prompts: 1, starts: 0 }, "a closed prompt sends nothing");
  for (let i = 0; i < 5; i++) {
    w.clock.t += 10_000;
    w.s.required();
    await w.settle();
  }
  assert.equal(w.count.prompts, 1, "every 401 in the next minute goes without a prompt");
  w.clock.t += 10_001;
  close = false;
  w.s.required();
  await w.settle();
  assert.equal(w.count.prompts, 2, "after 60 s a call that needs it asks again");
  assert.equal(await w.s.signedIn(), true);
  // The person asking (signIn()) goes inside the quiet time.
  const f = await wired({ sign: async () => { throw new Error("closed"); } });
  await f.run();
  assert.equal(await f.run(), false);
  assert.equal(f.count.prompts, 1);
  await f.run({ force: true });
  assert.equal(f.count.prompts, 2);
});
