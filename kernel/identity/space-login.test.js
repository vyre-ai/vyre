// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TEST_KDF } from "./master.js";
import { aesWrap, aesUnwrap } from "./wrap.js";
import { acceptKdf, buildRegistration, buildLinkMake, buildLinkRedeem, bundleHash, createLoginService, githubLinkMessage, GH_ASSERT_TAG, deriveLogin, loginMessage, registerMessage, LOGIN_KDF, KDF_FLOOR } from "./space-login.js";

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
const relayKey = identityKey();
/** A relay assertion for one space, as the relay's GitHub app signs it. @param {{ id?: string, space?: string, iat?: number, exp?: number, key?: any }} [o] @param {number} now */
function assertion(o = {}, now = 1_800_000_000_000) {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: o.id ?? "4242", login: "alex-gh", space: o.space ?? SPACE, iat: o.iat ?? now, exp: o.exp ?? now + 120_000 })).toString("base64url");
  return `${payload}.${(o.key || relayKey).sign(Buffer.from(`${GH_ASSERT_TAG}\n${payload}`))}`;
}

async function rig(o = {}) {
  const clock = { t: 1_800_000_000_000 };
  const store = new Map();
  const events = /** @type {any[]} */ ([]);
  const idKey = identityKey();
  const svc = createLoginService({
    space: SPACE, relayPub: relayKey.pub, store: { get: k => store.get(k), set: (k, v) => { store.set(k, v); }, keys: () => [...store.keys()] }, now: () => clock.t,
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
  return { ...(await r.svc.finish({ username, challenge: b.challenge, sig, device: { label: "Aina's laptop" } }, address)), K: d.K, challenge: b.challenge, sig };
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
  const again = await r.svc.finish({ username: "alex", challenge: first.challenge, sig: first.sig }, "203.0.113.9");
  assert.deepEqual(again.error, wrong.error);
  // expiry
  const b = r.svc.begin({ username: "alex" }, "203.0.113.10");
  const d = deriveLogin(PASSWORD, b.salt, TEST_KDF);
  r.clock.t += 61_000;
  assert.deepEqual((await r.svc.finish({ username: "alex", challenge: b.challenge, sig: d.sign(loginMessage(SPACE, "alex", b.challenge)) }, "203.0.113.10")).error, wrong.error);
  // a signature for another space does not log in here
  const c = r.svc.begin({ username: "alex" }, "203.0.113.11");
  const e = deriveLogin(PASSWORD, c.salt, TEST_KDF);
  assert.deepEqual((await r.svc.finish({ username: "alex", challenge: c.challenge, sig: e.sign(loginMessage("other", "alex", c.challenge)) }, "203.0.113.11")).error, wrong.error);
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
  // begin has only a high burst and never counts toward an address's failures, so nobody can lock others out with no password
  const r2 = await rig();
  let limited = 0;
  for (let i = 0; i < 130; i += 1) if (r2.svc.begin({ username: `user${i}x` }, "192.0.2.1").error) limited += 1;
  assert.ok(limited > 0, "a flood of begins is slowed");
  assert.equal(r2.svc.begin({ username: "alex" }, "192.0.2.77").error, undefined, "another address is not");
  const r3 = await rig();
  for (let i = 0; i < 100; i += 1) r3.svc.begin({ username: "alex" }, "192.0.2.9");
  assert.equal((await signIn(r3, "alex", PASSWORD, "192.0.2.10")).ok, true, "begins from one address never keep a member out");
  // twenty failed finishes from one address lock that address, whatever names it tries
  const r4 = await rig();
  for (let i = 0; i < 20; i += 1) await signIn(r4, `guess${i}xx`, "whatever whatever", "192.0.2.50");
  assert.equal(r4.svc.begin({ username: "alex" }, "192.0.2.50").error.code, "rate_limited");
  assert.equal(r4.svc.begin({ username: "alex" }, "192.0.2.51").error, undefined);
  // strikes fall back after a clean day
  const r5 = await rig();
  for (let i = 0; i < 5; i += 1) await signIn(r5, "alex", "wrong wrong wrong", "192.0.2.60");
  const first = r5.svc.begin({ username: "alex" }, "192.0.2.61").error.retry;
  r5.clock.t += 20_000;
  for (let i = 0; i < 5; i += 1) await signIn(r5, "alex", "wrong wrong wrong", "192.0.2.62");
  const second = r5.svc.begin({ username: "alex" }, "192.0.2.63").error.retry;
  assert.ok(second > first, "the second lock is longer");
  r5.clock.t += 25 * 3_600_000;
  for (let i = 0; i < 5; i += 1) await signIn(r5, "alex", "wrong wrong wrong", "192.0.2.64");
  assert.ok(r5.svc.begin({ username: "alex" }, "192.0.2.65").error.retry <= first, "after a clean day it starts over");
});

test("a known device does not ring the other devices again, and a new device id does", async () => {
  const r = await rig();
  const go = async (/** @type {any} */ device, address) => {
    const b = r.svc.begin({ username: "alex" }, address);
    const d = deriveLogin(PASSWORD, b.salt, TEST_KDF);
    return r.svc.finish({ username: "alex", challenge: b.challenge, sig: d.sign(loginMessage(SPACE, "alex", b.challenge)), device }, address);
  };
  assert.equal((await go({ id: "browser-aaaaaaaa", label: "Aina's laptop" }, "203.0.113.70")).ok, true);
  assert.equal((await go({ id: "browser-aaaaaaaa", label: "Aina's laptop" }, "203.0.113.71")).ok, true);
  assert.equal(r.events.length, 1, "the same browser again rings nobody");
  assert.equal(r.events[0].device, "browser-aaaaaaaa");
  await go({ id: "browser-bbbbbbbb", label: "A phone" }, "203.0.113.72");
  assert.equal(r.events.length, 2);
  await go({ label: "No id" }, "203.0.113.73");
  assert.equal(r.events.length, 3, "a sign-in that sends no device id is always new");
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

test("a password change makes a new salt and a new login key, and the old password stops working", async () => {
  const r = await rig();
  const change = await buildRegistration({
    space: SPACE, username: "alex", person: PERSON, password: "a brand new master password", kdf: TEST_KDF, identity: { pub: r.idKey.pub, sign: m => r.idKey.sign(m) },
    makeBundle: K => ({ v: 1, username: "alex", id: PERSON, passwordWrap: aesWrap(K, r.rk, "vyre:master:password:v1") }), now: () => r.clock.t,
  });
  assert.notEqual(change.body.salt, r.salt, "a new salt");
  assert.notEqual(change.body.loginPub, r.login.loginPub, "the login key rotated");
  assert.equal((await r.svc.register(change.body)).ok, true);
  assert.equal((await signIn(r, "alex", PASSWORD, "203.0.113.20")).error.code, "bad_login", "the old password no longer signs in");
  const next = await signIn(r, "alex", "a brand new master password", "203.0.113.21");
  assert.equal(next.ok, true);
  assert.deepEqual(aesUnwrap(next.K, next.bundle.passwordWrap, "vyre:master:password:v1"), r.rk);
});

test("GitHub sign-in: linked only by the relay's assertion plus the identity's signature, one account per username, and every miss is the plain bad login", async () => {
  const r = await rig();
  const link = (/** @type {any} */ o = {}) => {
    const ts = r.clock.t, a = o.assertion ?? assertion({}, r.clock.t);
    return r.svc.linkGithub({ username: "alex", person: PERSON, pub: r.idKey.pub, ts, sig: r.idKey.sign(githubLinkMessage(SPACE, "alex", "4242", ts)), assertion: a, ...o });
  };
  // not linked yet: a good assertion signs in as nobody
  assert.deepEqual((await r.svc.githubFinish({ assertion: assertion({}, r.clock.t) }, "203.0.113.30")).error.code, "bad_login");
  // the assertion alone does not link, the signature alone does not link, and neither does a forged or foreign one
  await assert.rejects(() => link({ sig: r.idKey.sign(Buffer.from("no")) }), (/** @type {any} */ e) => e.code === "denied");
  await assert.rejects(() => link({ assertion: assertion({ key: identityKey() }, r.clock.t) }), (/** @type {any} */ e) => e.code === "denied", "not the relay's key");
  await assert.rejects(() => link({ assertion: assertion({ space: "other" }, r.clock.t) }), (/** @type {any} */ e) => e.code === "denied", "another space's");
  await assert.rejects(() => link({ assertion: assertion({ iat: r.clock.t - 300_000, exp: r.clock.t - 1000 }, r.clock.t) }), (/** @type {any} */ e) => e.code === "denied", "expired");
  await assert.rejects(() => link({ assertion: "typed-login" }), (/** @type {any} */ e) => e.code === "denied", "a typed login is no assertion");
  await assert.rejects(() => link({ person: "per_" + "b".repeat(26) }), (/** @type {any} */ e) => e.code === "denied", "someone else's username");
  assert.equal((await link()).ok, true);
  // now the same GitHub account signs in, and gets the record and the salt to open it with the password
  const got = await r.svc.githubFinish({ assertion: assertion({}, r.clock.t), device: { label: "Aina's phone" } }, "203.0.113.31");
  assert.equal(got.ok, true);
  assert.equal(got.salt, r.salt);
  assert.ok(got.bundle && got.session);
  assert.equal(r.events.length, 1);
  // another GitHub account, a forged assertion and another space's all get the same answer
  const none = await r.svc.githubFinish({ assertion: assertion({ id: "999" }, r.clock.t) }, "203.0.113.32");
  assert.deepEqual(none.error, (await r.svc.githubFinish({ assertion: assertion({ key: identityKey() }, r.clock.t) }, "203.0.113.33")).error);
  assert.deepEqual(none.error, (await r.svc.githubFinish({ assertion: assertion({ space: "other" }, r.clock.t) }, "203.0.113.34")).error);
  // one username, one GitHub account; one GitHub account, one username
  await assert.rejects(() => r.svc.linkGithub({ username: "alex", person: PERSON, pub: r.idKey.pub, ts: r.clock.t, sig: r.idKey.sign(githubLinkMessage(SPACE, "alex", "5555", r.clock.t)), assertion: assertion({ id: "5555" }, r.clock.t) }), (/** @type {any} */ e) => e.code === "denied" && /different GitHub/.test(e.message));
});

test("a person can list their live sign-ins and sign one device out; the device must sign in again and rings the others", async () => {
  const r = await rig();
  const go = async (/** @type {any} */ device, address) => {
    const b = r.svc.begin({ username: "alex" }, address);
    const d = deriveLogin(PASSWORD, b.salt, TEST_KDF);
    return r.svc.finish({ username: "alex", challenge: b.challenge, sig: d.sign(loginMessage(SPACE, "alex", b.challenge)), device }, address);
  };
  await go({ id: "browser-aaaaaaaa", label: "Aina's laptop" }, "203.0.113.80");
  r.clock.t += 1000;
  await go({ id: "browser-bbbbbbbb", label: "A phone" }, "203.0.113.81");
  const list = r.svc.sessionsOf("alex");
  assert.deepEqual(list.map(x => [x.device, x.label]), [["browser-bbbbbbbb", "A phone"], ["browser-aaaaaaaa", "Aina's laptop"]], "newest first");
  assert.equal(JSON.stringify(list).includes("session"), false, "no session secret is listed");
  assert.equal(r.svc.revokeDevice("alex", "browser-aaaaaaaa").revoked, true);
  assert.deepEqual(r.svc.sessionsOf("alex").map(x => x.device), ["browser-bbbbbbbb"]);
  assert.equal(r.svc.revokeDevice("blair", "browser-bbbbbbbb").revoked, false, "another person's device is not touched");
  assert.equal(r.svc.sessionsOf("alex").length, 1);
  const before = r.events.length;
  await go({ id: "browser-aaaaaaaa", label: "Aina's laptop" }, "203.0.113.82");
  assert.equal(r.events.length, before + 1, "the signed-out device is new again and rings the others");
});

/** A new device with a fresh key of its own. */
function newDevice() {
  const k = identityKey();
  return { pub: k.pub, sign: (/** @type {Buffer} */ m) => k.sign(m) };
}

test("a device link: made by the identity, redeemed once with a fresh device key, and the record still needs the master password", async () => {
  const r = await rig();
  const made = await buildLinkMake({ space: SPACE, person: PERSON, identity: { pub: r.idKey.pub, sign: m => r.idKey.sign(m) }, now: () => r.clock.t });
  assert.equal(JSON.stringify(made.body).includes(made.nonce), false, "the nonce itself never goes to the space");
  assert.equal((await r.svc.linkMake(made.body)).ok, true);
  const dev = newDevice();
  const redeem = await buildLinkRedeem({ space: SPACE, nonce: made.nonce, device: { id: "phone-aaaaaaaa", label: "Aina's phone", ...dev } });
  const got = await r.svc.linkRedeem(redeem, "203.0.113.90");
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.salt, r.salt);
  assert.deepEqual(aesUnwrap(deriveLogin(PASSWORD, got.salt, TEST_KDF).K, got.bundle.passwordWrap, "vyre:master:password:v1"), r.rk, "the master password opens it");
  assert.equal(r.events.at(-1).device, "phone-aaaaaaaa", "the other devices are told");
  // a second use, with the same signed request or a new one, is link_used
  const again = await r.svc.linkRedeem(redeem, "203.0.113.91");
  assert.equal(again.error.code, "link_used");
  assert.equal((await r.svc.linkRedeem(await buildLinkRedeem({ space: SPACE, nonce: made.nonce, device: { label: "x", ...newDevice() } }), "203.0.113.92")).error.code, "link_used");
});

test("a device link that is wrong, old, for another space, made by a stranger or not by a member fails plainly and burns", async () => {
  const r = await rig();
  const mk = async (/** @type {any} */ o = {}) => buildLinkMake({ space: SPACE, person: PERSON, identity: { pub: r.idKey.pub, sign: m => r.idKey.sign(m) }, now: () => r.clock.t, ...o });
  // a link nobody made, and a malformed one
  assert.equal((await r.svc.linkRedeem(await buildLinkRedeem({ space: SPACE, nonce: crypto.randomBytes(32).toString("base64url"), device: { label: "x", ...newDevice() } }), "198.51.100.1")).error.code, "bad_link");
  assert.equal((await r.svc.linkRedeem({ nonce: "short", device: {} }, "198.51.100.2")).error.code, "bad_link");
  // expiry
  const old = await mk();
  await r.svc.linkMake(old.body);
  r.clock.t += 5 * 60_000 + 1;
  assert.equal((await r.svc.linkRedeem(await buildLinkRedeem({ space: SPACE, nonce: old.nonce, device: { label: "x", ...newDevice() } }), "198.51.100.3")).error.code, "link_expired");
  // a request for another space does not make a link here, a stranger's key does not, a non-member does not
  await assert.rejects(async () => r.svc.linkMake((await mk({ space: "other" })).body), (/** @type {any} */ e) => e.code === "denied");
  const stranger = identityKey();
  await assert.rejects(async () => r.svc.linkMake((await mk({ identity: { pub: stranger.pub, sign: (/** @type {Buffer} */ m) => stranger.sign(m) } })).body), (/** @type {any} */ e) => e.code === "denied", "a key the person never published");
  await assert.rejects(async () => r.svc.linkMake((await mk({ person: "per_" + "b".repeat(26) })).body), (/** @type {any} */ e) => e.code === "denied");
  await assert.rejects(async () => r.svc.linkMake({ ...(await mk()).body, exp: r.clock.t + 3_600_000 }), (/** @type {any} */ e) => e.code === "bad_input", "a link lasts five minutes");
  // a redeem signed by some key other than the device's own is refused, and the link is gone
  const fresh = await mk();
  await r.svc.linkMake(fresh.body);
  const bad = await buildLinkRedeem({ space: SPACE, nonce: fresh.nonce, device: { label: "x", ...newDevice() } });
  const wrong = { ...bad, sig: newDevice().sign(Buffer.from("not the redeem message")) };
  assert.equal((await r.svc.linkRedeem(wrong, "198.51.100.4")).error.code, "bad_link");
  assert.equal((await r.svc.linkRedeem(bad, "198.51.100.5")).error.code, "link_used", "burned by the first presentation");
});

test("at most five device links wait for one person", async () => {
  const r = await rig();
  for (let i = 0; i < 5; i += 1) await r.svc.linkMake((await buildLinkMake({ space: SPACE, person: PERSON, identity: { pub: r.idKey.pub, sign: m => r.idKey.sign(m) }, now: () => r.clock.t })).body);
  await assert.rejects(async () => r.svc.linkMake((await buildLinkMake({ space: SPACE, person: PERSON, identity: { pub: r.idKey.pub, sign: m => r.idKey.sign(m) }, now: () => r.clock.t })).body), (/** @type {any} */ e) => e.code === "rate_limited");
});
