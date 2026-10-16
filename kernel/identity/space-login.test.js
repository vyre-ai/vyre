// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TEST_KDF } from "./master.js";
import { aesWrap, aesUnwrap } from "./wrap.js";
import { acceptKdf, bundleHash, createLoginService, deriveLogin, loginMessage, registerMessage, LOGIN_KDF, KDF_FLOOR } from "./space-login.js";

const SPACE = "juniper";
const PERSON = "per_" + "a".repeat(26);
const PASSWORD = "correct horse battery";
const salt = () => crypto.randomBytes(16).toString("base64url");

function identityKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  return { pub, sign: (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey).toString("base64url") };
}

/** A service, a clock the test moves, and one registered person. */
async function rig(o = {}) {
  const clock = { t: 1_800_000_000_000 };
  const store = new Map();
  const events = /** @type {any[]} */ ([]);
  const idKey = identityKey();
  const svc = createLoginService({
    space: SPACE, store: { get: k => store.get(k), set: (k, v) => { store.set(k, v); } }, now: () => clock.t,
    verifyIdentity: async (person, pub) => person === PERSON && pub === idKey.pub, isMember: async u => u === "alex" || u === "blair",
    onNewDevice: e => events.push(e), ...o,
  });
  const s = salt();
  const login = deriveLogin(PASSWORD, s, TEST_KDF);
  const rk = crypto.randomBytes(32);
  const bundle = { v: 1, username: "alex", id: PERSON, passwordWrap: aesWrap(login.K, rk, "vyre:master:password:v1") };
  const ts = clock.t;
  const sig = idKey.sign(registerMessage(SPACE, "alex", login.loginPub, bundleHash(bundle), ts));
  await svc.register({ username: "alex", person: PERSON, pub: idKey.pub, ts, sig, salt: s, loginPub: login.loginPub, bundle });
  return { svc, clock, events, salt: s, rk, idKey, bundle, login };
}

/** What a device does: begin, derive, sign, finish. */
async function signIn(r, username, password, address = "203.0.113.5", kdf = TEST_KDF) {
  const b = r.svc.begin({ username }, address);
  if (b.error) return b;
  const d = deriveLogin(password, b.salt, kdf);
  const sig = d.sign(loginMessage(SPACE, username, b.challenge));
  return { ...r.svc.finish({ username, challenge: b.challenge, sig, device: { label: "Aina's laptop" } }, address), K: d.K, challenge: b.challenge, sig };
}

test("the right password gets the record, opens it with K, and the server never held K", async () => {
  const r = await rig();
  const got = await signIn(r, "alex", PASSWORD);
  assert.equal(got.ok, true);
  assert.deepEqual(aesUnwrap(got.K, got.bundle.passwordWrap, "vyre:master:password:v1"), r.rk);
  assert.ok(got.session);
  assert.equal(r.events.length, 1, "the other devices are told");
  assert.equal(r.events[0].username, "alex");
  assert.equal(r.events[0].label, "Aina's laptop");
  assert.equal(JSON.stringify(r.svc.begin({ username: "alex" }, "203.0.113.6")).includes(PASSWORD), false);
});

test("a wrong password, an unknown name and a replayed or expired challenge all get the same answer, and begin has one shape", async () => {
  const r = await rig();
  const wrong = await signIn(r, "alex", "not the right password at all");
  const none = await signIn(r, "nobody", PASSWORD);
  assert.deepEqual(wrong.error, none.error);
  assert.equal(wrong.error.code, "bad_login");
  const a = r.svc.begin({ username: "alex" }, "203.0.113.7"), n = r.svc.begin({ username: "nobody" }, "203.0.113.7");
  assert.deepEqual(Object.keys(a).sort(), Object.keys(n).sort());
  assert.deepEqual(a.kdf, n.kdf);
  assert.equal(n.salt, r.svc.begin({ username: "nobody" }, "203.0.113.8").salt, "the fake salt is the same every time");
  // replay: the same signed challenge twice
  const first = await signIn(r, "alex", PASSWORD, "203.0.113.9");
  assert.equal(first.ok, true);
  const again = r.svc.finish({ username: "alex", challenge: first.challenge, sig: first.sig }, "203.0.113.9");
  assert.deepEqual(again.error, wrong.error);
  // expiry
  const b = r.svc.begin({ username: "alex" }, "203.0.113.10");
  const d = deriveLogin(PASSWORD, b.salt, TEST_KDF);
  r.clock.t += 61_000;
  assert.deepEqual(r.svc.finish({ username: "alex", challenge: b.challenge, sig: d.sign(loginMessage(SPACE, "alex", b.challenge)) }, "203.0.113.10").error, wrong.error);
  // a signature for another space does not log in here
  const c = r.svc.begin({ username: "alex" }, "203.0.113.11");
  const e = deriveLogin(PASSWORD, c.salt, TEST_KDF);
  assert.deepEqual(r.svc.finish({ username: "alex", challenge: c.challenge, sig: e.sign(loginMessage("other", "alex", c.challenge)) }, "203.0.113.11").error, wrong.error);
});

test("a username is locked out after five misses, an address after twenty tries, and the lockout ends", async () => {
  const r = await rig();
  for (let i = 0; i < 5; i += 1) assert.equal((await signIn(r, "alex", "wrong wrong wrong wrong", `198.51.100.${i}`)).error.code, "bad_login");
  const locked = r.svc.begin({ username: "alex" }, "198.51.100.99");
  assert.equal(locked.error.code, "rate_limited");
  assert.ok(locked.error.retry > 0);
  assert.equal((await signIn(r, "alex", PASSWORD, "198.51.100.98")).error.code, "rate_limited", "even the right password waits");
  r.clock.t += 20_000;
  assert.equal((await signIn(r, "alex", PASSWORD, "198.51.100.97")).ok, true, "after the wait the right password works");
  // one address hammering many names
  const r2 = await rig();
  let limited = 0;
  for (let i = 0; i < 40; i += 1) if (r2.svc.begin({ username: `user${i}x` }, "192.0.2.1").error) limited += 1;
  assert.ok(limited > 0, "an address is slowed down");
  assert.equal(r2.svc.begin({ username: "alex" }, "192.0.2.77").error, undefined, "another address is not");
});

test("registering needs the identity's signature, a published key, a member and the same person", async () => {
  const r = await rig();
  const s = salt(), login = deriveLogin(PASSWORD, s, TEST_KDF), bundle = { v: 1, x: 1 };
  const ts = r.clock.t;
  const good = { username: "blair", person: PERSON, pub: r.idKey.pub, ts, sig: r.idKey.sign(registerMessage(SPACE, "blair", login.loginPub, bundleHash(bundle), ts)), salt: s, loginPub: login.loginPub, bundle };
  await assert.rejects(() => r.svc.register({ ...good, sig: r.idKey.sign(Buffer.from("something else")) }), (/** @type {any} */ e) => e.code === "denied");
  const other = identityKey();
  await assert.rejects(() => r.svc.register({ ...good, pub: other.pub, sig: other.sign(registerMessage(SPACE, "blair", login.loginPub, bundleHash(bundle), ts)) }), (/** @type {any} */ e) => e.code === "denied", "a key the person never published");
  await assert.rejects(() => r.svc.register({ ...good, username: "mallory", sig: r.idKey.sign(registerMessage(SPACE, "mallory", login.loginPub, bundleHash(bundle), ts)) }), (/** @type {any} */ e) => e.code === "denied", "not a member");
  await assert.rejects(() => r.svc.register({ ...good, ts: ts - 10 * 60_000, sig: r.idKey.sign(registerMessage(SPACE, "blair", login.loginPub, bundleHash(bundle), ts - 10 * 60_000)) }), (/** @type {any} */ e) => e.code === "expired");
  await assert.rejects(() => r.svc.register({ ...good, bundle: { v: 1, x: 2 } }), (/** @type {any} */ e) => e.code === "denied", "the bundle is covered by the signature");
  assert.equal((await r.svc.register(good)).ok, true);
  // someone else's name cannot be taken over, even by a published, signed key of another person
  const stranger = "per_" + "b".repeat(26);
  const svc2 = createLoginService({ space: SPACE, store: { get: () => ({ person: PERSON }), set() {} }, now: () => ts, verifyIdentity: async () => true, isMember: async () => true });
  await assert.rejects(() => svc2.register({ ...good, person: stranger }), (/** @type {any} */ e) => e.code === "denied" && /someone else/.test(e.message));
});

test("a device refuses a KDF that is too weak or too heavy, and the login key is not the wrap key", () => {
  assert.deepEqual(acceptKdf(LOGIN_KDF), LOGIN_KDF);
  for (const bad of [{ ...LOGIN_KDF, memoryKiB: KDF_FLOOR.memoryKiB - 1 }, { ...LOGIN_KDF, passes: 1 }, { ...LOGIN_KDF, memoryKiB: 1 << 20 }, { ...LOGIN_KDF, passes: 99 }, { ...LOGIN_KDF, lanes: 2 }, null, "x"]) {
    assert.throws(() => acceptKdf(bad), (/** @type {any} */ e) => e.code === "bad_kdf");
  }
  const d = deriveLogin(PASSWORD, "AAAAAAAAAAAAAAAAAAAAAA", TEST_KDF);
  assert.notEqual(Buffer.from(d.loginPub, "base64url").toString("hex"), d.K.toString("hex"));
  assert.equal(deriveLogin(PASSWORD, "AAAAAAAAAAAAAAAAAAAAAA", TEST_KDF).loginPub, d.loginPub, "deterministic");
  assert.notEqual(deriveLogin(PASSWORD, "BBBBBBBBBBBBBBBBBBBBBB", TEST_KDF).loginPub, d.loginPub, "salted");
});
