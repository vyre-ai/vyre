// @ts-check
// Sign in from any device with a space address, a username and the master password, without the password or anything that stands in for it reaching the server.
//
// The device asks <space>.vyre.run for the username's salt and KDF parameters, derives K = Argon2id(password, salt) locally (the same K the master record's password wrap uses), and from K
// a login seed. It signs a single-use challenge with the Ed25519 key of that seed. The server holds only the login PUBLIC key and the master record (already wrapped by K); it returns the
// record once a challenge is signed, and the device opens it with K. The server never sees the password or K.
//
// Honest limit: this is a signature login, not an augmented PAKE. A server that holds the record and the login public key can test password guesses offline, each costing one Argon2id run
// (64 MiB, 3 passes). The master record's own password wrap gives the same test to anyone who holds it, so the login key adds no new weakness, and the record is returned only to a signed
// challenge. The defence is the KDF cost, the password rule, and the rate limits below on the online path.
//
// Pure: no fetch, no files except the optional record store. The device and the daemon run the same bytes.

import crypto from "node:crypto";
import { hkdf32 } from "./wrap.js";
import { argon2id } from "./stretch.js";

export const LOGIN_TAG = "vyre-login-v1";
export const REGISTER_TAG = "vyre-login-register-v1";
/** The KDF every record is made with, so the answer for a name that does not exist has the same shape as one that does. */
export const LOGIN_KDF = Object.freeze({ memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 });
/** What a device accepts from a server: below the floor a hostile server could cheapen guessing, above the ceiling it could make the device burn memory. */
export const KDF_FLOOR = Object.freeze({ memoryKiB: 19456, passes: 2 });
export const KDF_CEIL = Object.freeze({ memoryKiB: 262144, passes: 6 });
export const CHALLENGE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 60 * 60_000;
const NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;
const BAD_LOGIN = "That username and password do not match.";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const fail = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ more = {}) => Object.assign(new Error(message), { code, ...more });
const b64 = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");

/** A server-supplied KDF is refused outside the floor and ceiling. @param {any} kdf */
export function acceptKdf(kdf) {
  const k = kdf && typeof kdf === "object" ? kdf : {};
  const ok = Number.isInteger(k.memoryKiB) && Number.isInteger(k.passes) && k.lanes === 1 && k.tagLength === 32
    && k.memoryKiB >= KDF_FLOOR.memoryKiB && k.memoryKiB <= KDF_CEIL.memoryKiB && k.passes >= KDF_FLOOR.passes && k.passes <= KDF_CEIL.passes;
  if (!ok) throw fail("bad_kdf", "This server asked for password settings that are too weak or too heavy. Nothing was sent. Check the space address.");
  return { memoryKiB: k.memoryKiB, passes: k.passes, lanes: 1, tagLength: 32 };
}

/** The bytes a device signs to log in. @param {string} space @param {string} username @param {string} challenge */
export const loginMessage = (space, username, challenge) => Buffer.from(`${LOGIN_TAG}\n${space}\n${username}\n${challenge}`);

/**
 * K, the login key pair and nothing else the server must not have. `K` is returned so the caller can open the master record with it, then zero it.
 * @param {string} password already normalised (NFKC) @param {Uint8Array|string} salt raw bytes, or base64url @param {{ memoryKiB: number, passes: number, lanes?: number, tagLength?: number, pure?: boolean }} kdf
 */
export function deriveLogin(password, salt, kdf) {
  const saltBytes = typeof salt === "string" ? Buffer.from(salt, "base64url") : Buffer.from(salt);
  const K = argon2id(password, saltBytes, { lanes: 1, tagLength: 32, ...kdf });
  const seed = hkdf32(K, "vyre-login-seed-v1", "vyre:login:seed:v1");
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  seed.fill(0);
  return { K, loginPub: b64(pub), sign: (/** @type {Uint8Array} */ msg) => b64(crypto.sign(null, Buffer.from(msg), priv)) };
}

/** @param {string} pubB64 @param {Uint8Array} msg @param {string} sigB64 */
function verifies(pubB64, msg, sigB64) {
  try {
    const pub = Buffer.from(pubB64, "base64url");
    if (pub.length !== 32) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: "der", type: "spki" });
    const sig = Buffer.from(sigB64, "base64url");
    return sig.length === 64 && crypto.verify(null, Buffer.from(msg), key, sig);
  } catch { return false; }
}

/** What the person's identity key signs to register or replace a login record. @param {string} space @param {string} username @param {string} loginPub @param {string} bundleHash @param {number} ts */
export const registerMessage = (space, username, loginPub, bundleHash, ts) => Buffer.from(`${REGISTER_TAG}\n${space}\n${username}\n${loginPub}\n${bundleHash}\n${ts}`);
/** @param {any} bundle */
export const bundleHash = bundle => crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("base64url");

/** A fixed-window counter per key with a doubling lockout after repeated misses. @param {() => number} now */
function limiter(now) {
  /** @type {Map<string, { n: number, at: number, until: number, strikes: number, locked: number }>} */ const m = new Map();
  return {
    /** Seconds to wait, or 0 when allowed. @param {string} key @param {number} max @param {number} windowMs */
    wait(key, max, windowMs) {
      const t = now(), e = m.get(key);
      if (!e) return 0;
      if (e.until > t) return Math.ceil((e.until - t) / 1000);
      if (t - e.at > windowMs) { e.n = 0; }
      return 0;
    },
    /** Count one attempt; lock out when over `max`. @param {string} key @param {number} max @param {number} windowMs */
    hit(key, max, windowMs) {
      const t = now();
      let e = m.get(key);
      if (!e) { e = { n: 0, at: t, until: 0, strikes: 0, locked: 0 }; m.set(key, e); }
      if (t - e.at > windowMs) { e.n = 0; e.at = t; }
      e.n += 1;
      if (e.n >= max) { if (e.locked && t - e.locked > 24 * 3_600_000) e.strikes = 0; e.locked = t; e.strikes += 1; e.until = t + Math.min(15 * 60_000, 15_000 * 2 ** (e.strikes - 1)); e.n = 0; e.at = t; }
      if (m.size > 20_000) for (const [k, v] of m) if (v.until < t && t - v.at > Math.max(windowMs, 24 * 3_600_000)) m.delete(k);
    },
    clear(/** @type {string} */ key) { m.delete(key); },
  };
}

export const GH_ASSERT_TAG = "vyre-gh-assert-v1";
export const GH_LINK_TAG = "vyre-login-github-link-v1";
export const LINK_MAKE_TAG = "vyre-link-make-v1";
export const LINK_REDEEM_TAG = "vyre-link-redeem-v1";
/** A device link lives this long and works once. */
export const LINK_TTL_MS = 5 * 60_000;
const LINK_LIVE_MAX = 5;
const sha256b64 = (/** @type {Uint8Array} */ b) => b64(crypto.createHash("sha256").update(b).digest());
/** What the identity key signs to make a device link: the hash of the nonce, never the nonce. @param {string} space @param {string} person @param {string} h @param {number} exp @param {number} ts */
export const linkMakeMessage = (space, person, h, exp, ts) => Buffer.from(`${LINK_MAKE_TAG}\n${space}\n${person}\n${h}\n${exp}\n${ts}`);
/** What a new device signs, with its own fresh key, to redeem a link. @param {string} space @param {string} h @param {string} devicePub */
export const linkRedeemMessage = (space, h, devicePub) => Buffer.from(`${LINK_REDEEM_TAG}\n${space}\n${h}\n${devicePub}`);

/**
 * The request that makes a link, and the nonce that goes in the URL fragment (https://<space>.vyre.run/d#<nonce>). Only the hash of the nonce is sent.
 * @param {{ space: string, person: string, identity: { pub: string, sign: (msg: Buffer) => string | Promise<string> }, now?: () => number, random?: (n: number) => Buffer }} o
 */
export async function buildLinkMake(o) {
  const nonce = b64((o.random || (n => crypto.randomBytes(n)))(32));
  const h = sha256b64(Buffer.from(nonce, "base64url"));
  const ts = (o.now || Date.now)(), exp = ts + LINK_TTL_MS;
  const sig = await o.identity.sign(linkMakeMessage(o.space, o.person, h, exp, ts));
  return { nonce, body: { op: "link-make", person: o.person, pub: o.identity.pub, ts, exp, sig, h } };
}

/** The request a new device sends to redeem a link, with its own fresh key. @param {{ space: string, nonce: string, device: { id?: string, label?: string, pub: string, sign: (msg: Buffer) => string | Promise<string> } }} o */
export async function buildLinkRedeem(o) {
  const h = sha256b64(Buffer.from(o.nonce, "base64url"));
  const sig = await o.device.sign(linkRedeemMessage(o.space, h, o.device.pub));
  return { op: "link-redeem", nonce: o.nonce, sig, device: { ...(o.device.id ? { id: o.device.id } : {}), label: o.device.label || "A new device", pub: o.device.pub } };
}

/**
 * What the relay's GitHub app signs once GitHub itself has confirmed a person at the OAuth callback: the numeric GitHub id for one space, for two minutes. A space accepts it only against the relay
 * public key it was told, and only for its own name.
 * @param {string} token "<payload b64url>.<signature b64url>" @param {string} relayPub the relay's Ed25519 public key (base64url) @param {string} space @param {() => number} [now]
 * @returns {{ id: string, login: string, name: string } | null}
 */
export function verifyGithubAssertion(token, relayPub, space, now = Date.now) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !relayPub) return null;
  if (!verifies(relayPub, Buffer.from(`${GH_ASSERT_TAG}\n${payload}`), sig)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!p || p.v !== 1 || p.space !== space || !/^[0-9]{1,18}$/.test(String(p.id)) || !Number.isFinite(p.exp) || p.exp <= now() || !Number.isFinite(p.iat) || p.iat > now() + 60_000) return null;
  return { id: String(p.id), login: String(p.login || ""), name: typeof p.name === "string" ? p.name : "" };
}

/** What the identity key signs to link a GitHub account to a username in a space. @param {string} space @param {string} username @param {string} ghid @param {number} ts */
export const githubLinkMessage = (space, username, ghid, ts) => Buffer.from(`${GH_LINK_TAG}\n${space}\n${username}\n${ghid}\n${ts}`);

/**
 * The body of a `register` request, for a new username and for a password change alike (a change makes a new salt, so the login key rotates). `makeBundle(K)` wraps the master record under
 * the new K and returns it. The identity key signs the whole thing, so only the identity can set or replace a record. The caller zeroes the returned `K` when it is done with it.
 * @param {{ space: string, username: string, person: string, password: string, kdf?: any, identity: { pub: string, sign: (msg: Buffer) => string | Promise<string> }, makeBundle: (K: Buffer) => any, now?: () => number, random?: (n: number) => Buffer }} o
 */
export async function buildRegistration(o) {
  const salt = b64((o.random || (n => crypto.randomBytes(n)))(16));
  const d = deriveLogin(o.password, salt, o.kdf || LOGIN_KDF);
  const bundle = o.makeBundle(d.K);
  const ts = (o.now || Date.now)();
  const sig = await o.identity.sign(registerMessage(o.space, o.username, d.loginPub, bundleHash(bundle), ts));
  return { K: d.K, body: { op: "register", username: o.username, person: o.person, pub: o.identity.pub, ts, sig, salt, loginPub: d.loginPub, bundle } };
}

/**
 * The server side for one space. State that must survive a restart (records) goes through `store`; challenges, sessions and counters are memory only.
 * @param {{ space: string, store: { get: (k: string) => any, set: (k: string, v: any) => void, keys?: () => string[] }, secret?: Buffer, now?: () => number, random?: (n: number) => Buffer,
 *   relayPub?: string, describe?: (username: string, rec: any) => Promise<Record<string, any>> | Record<string, any>, isMember?: (username: string, person: string) => boolean | Promise<boolean>, verifyIdentity?: (person: string, pub: string) => Promise<boolean>, onNewDevice?: (e: { username: string, device: string, label: string, address: string, at: number }) => void }} o
 */
export function createLoginService(o) {
  const now = o.now || Date.now;
  const rnd = o.random || (n => crypto.randomBytes(n));
  const secret = o.secret || rnd(32);
  const dummy = deriveDummy(secret);
  /** @type {Map<string, { username: string, address: string, exp: number }>} */ const challenges = new Map();
  /** @type {Map<string, { username: string, exp: number, device: string, label: string, at: number }>} */ const sessions = new Map();
  const lim = limiter(now);
  const PER_ADDR = 20, PER_NAME = 5, BURST = 120, WINDOW = 60_000, NAME_WINDOW = 15 * 60_000;
  const burst = (/** @type {string} */ address) => lim.wait(`b:${address}`, BURST, WINDOW);
  const sweep = () => { const t = now(); for (const [k, c] of challenges) if (c.exp <= t) challenges.delete(k); for (const [k, s] of sessions) if (s.exp <= t) sessions.delete(k); };
  const limited = (/** @type {string} */ username, /** @type {string} */ address) => Math.max(lim.wait(`a:${address}`, PER_ADDR, WINDOW), lim.wait(`n:${username}`, PER_NAME, NAME_WINDOW));
  const tooMany = (/** @type {number} */ s) => ({ error: { code: "rate_limited", message: `Too many tries. Wait ${s} seconds and try again.`, retry: s } });
  const fakeSalt = (/** @type {string} */ username) => b64(crypto.createHmac("sha256", secret).update(`salt\n${username}`).digest().subarray(0, 16));
  const record = (/** @type {string} */ username) => { const r = o.store.get(`login:${username}`); return r && typeof r === "object" ? r : null; };

  /** Device links, in memory: a restart ends them, five minutes is all they live. h -> { person, username, exp, used }. @type {Map<string, { person: string, username: string, exp: number, used: boolean }>} */
  const links = new Map();
  const sweepLinks = () => { const t = now(); for (const [k, l] of links) if (l.exp + 60_000 <= t) links.delete(k); };
  const usernamesOfPerson = (/** @type {string} */ person) => (typeof o.store.keys === "function" ? o.store.keys() : []).filter(k => k.startsWith("login:")).map(k => k.slice(6)).filter(u => { const r = record(u); return Boolean(r && r.person === String(person)); });
  /** The new-device notice, once per device id. A device sends a stable id (`device.id`); one we have seen before rings nobody. No id means each sign-in is a new device. */
  function seen(/** @type {any} */ rec, /** @type {string} */ username, /** @type {any} */ input, /** @type {string} */ label, /** @type {string} */ address) {
    const id = deviceIdOf(username, input, address);
    const raw = clientDeviceId(input);
    const known = Array.isArray(rec.devices) ? rec.devices : [];
    if (raw && known.includes(raw)) return id;
    if (raw) { try { o.store.set(`login:${username}`, { ...rec, devices: [...known, raw].slice(-50) }); } catch { /* the notice still goes */ } }
    try { o.onNewDevice && o.onNewDevice({ username, device: id, label, address, at: now() }); } catch { /* the notice failing never blocks the person */ }
    return id;
  }
  /** The client's own stable id, or empty. @param {any} input */
  const clientDeviceId = input => (input && input.device && typeof input.device.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(input.device.id) ? input.device.id : "");
  /** The device id a sign-in is known by: the client's own, else a hash that is new each time. */
  const deviceIdOf = (/** @type {string} */ username, /** @type {any} */ input, /** @type {string} */ address) => clientDeviceId(input) || b64(crypto.createHash("sha256").update(`${username}\n${address}\n${now()}`).digest()).slice(0, 16);

  return {
    /** Step 1. Always the same shape, whether or not the name exists. */
    begin(/** @type {{ username?: string }} */ input, /** @type {string} */ address) {
      const username = String(input && input.username || "").trim().toLowerCase();
      if (!NAME.test(username)) return { error: { code: "bad_input", message: "Type your username." } };
      const wait = Math.max(limited(username, address), burst(address));
      if (wait) return tooMany(wait);
      lim.hit(`b:${address}`, BURST, WINDOW);
      sweep();
      const rec = record(username);
      const challenge = b64(rnd(32));
      challenges.set(challenge, { username, address, exp: now() + CHALLENGE_TTL_MS });
      return { salt: rec ? rec.salt : fakeSalt(username), kdf: { ...LOGIN_KDF }, challenge, expires: now() + CHALLENGE_TTL_MS };
    },
    /** Step 2. A challenge is spent the first time it is seen, right or wrong. Every failure is the same answer. */
    async finish(/** @type {{ username?: string, challenge?: string, sig?: string, device?: { label?: string } }} */ input, /** @type {string} */ address) {
      const username = String(input && input.username || "").trim().toLowerCase();
      const wait = limited(username, address);
      if (wait) return tooMany(wait);
      sweep();
      const ch = String(input && input.challenge || "");
      const c = challenges.get(ch);
      challenges.delete(ch);
      const rec = NAME.test(username) ? record(username) : null;
      const fresh = Boolean(c && c.exp > now() && c.username === username);
      const pub = rec && typeof rec.loginPub === "string" ? rec.loginPub : dummy;
      const signed = verifies(pub, loginMessage(o.space, username, ch), String(input && input.sig || ""));
      if (!(fresh && signed && rec)) {
        lim.hit(`n:${username}`, PER_NAME, NAME_WINDOW);
        lim.hit(`a:${address}`, PER_ADDR, WINDOW);
        return { error: { code: "bad_login", message: BAD_LOGIN } };
      }
      lim.clear(`n:${username}`);
      sweep();
      const session = b64(rnd(32));
      const label0 = String(input && input.device && input.device.label || "A new device").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
      const dev = seen(rec, username, input, label0, address);
      sessions.set(session, { username, exp: now() + SESSION_TTL_MS, device: dev, label: label0, at: now() });
      const more = o.describe ? await Promise.resolve(o.describe(username, rec)).catch(() => ({})) : {};
      return { ok: true, session, expires: now() + SESSION_TTL_MS, bundle: rec.bundle, ...more };
    },
    /**
     * Set or replace a username's record. The identity key signs it; the person must be a member of this space and the key must be one the person has published. A replace needs the same.
     * @param {{ username: string, person: string, pub: string, ts: number, sig: string, salt: string, loginPub: string, bundle: any }} input
     */
    async register(input) {
      const username = String(input && input.username || "").trim().toLowerCase();
      if (!NAME.test(username)) throw fail("bad_input", "Type the username.");
      if (!/^[A-Za-z0-9_-]{22}$/.test(String(input.salt)) || !/^[A-Za-z0-9_-]{43}$/.test(String(input.loginPub)) || !input.bundle || typeof input.bundle !== "object") throw fail("bad_input", "That sign-in record is not in the right shape.");
      if (Math.abs(now() - Number(input.ts)) > 5 * 60_000) throw fail("expired", "That request is too old. Try again.");
      const msg = registerMessage(o.space, username, input.loginPub, bundleHash(input.bundle), Number(input.ts));
      if (!verifies(String(input.pub), msg, String(input.sig))) throw fail("denied", "That request is not signed by the identity.");
      if (!o.verifyIdentity || !(await o.verifyIdentity(String(input.person), String(input.pub)))) throw fail("denied", "That key is not one this person has published.");
      if (o.isMember && !(await o.isMember(username, String(input.person)))) throw fail("denied", "That username is not a member of this space.");
      const held = record(username);
      if (held && held.person !== input.person) throw fail("denied", "That username belongs to someone else.");
      o.store.set(`login:${username}`, { person: String(input.person), salt: input.salt, kdf: { ...LOGIN_KDF }, loginPub: input.loginPub, bundle: input.bundle, at: now() });
      return { ok: true, username };
    },
    /**
     * Sign in with GitHub: the relay's signed assertion names the GitHub id, and this space maps that id to the username it was linked to. The device then opens the record with the master password.
     * Every failure is the same answer as a wrong password.
     * @param {{ assertion?: string, device?: { label?: string } }} input @param {string} address
     */
    async githubFinish(input, address) {
      const wait = Math.max(lim.wait(`a:${address}`, PER_ADDR, WINDOW), 0);
      if (wait) return tooMany(wait);
      sweep();
      const who = verifyGithubAssertion(String(input && input.assertion || ""), String(o.relayPub || ""), o.space, now);
      const username = who ? o.store.get(`gh:${who.id}`) : null;
      const rec = typeof username === "string" ? record(username) : null;
      if (!who || !rec) { lim.hit(`a:${address}`, PER_ADDR, WINDOW); return { error: { code: "bad_login", message: BAD_LOGIN } }; }
      const session = b64(rnd(32));
      const label0 = String(input && input.device && input.device.label || "A new device").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
      const dev = seen(rec, String(username), input, label0, address);
      sessions.set(session, { username: String(username), exp: now() + SESSION_TTL_MS, device: dev, label: label0, at: now() });
      const more = o.describe ? await Promise.resolve(o.describe(String(username), rec)).catch(() => ({})) : {};
      return { ok: true, session, expires: now() + SESSION_TTL_MS, salt: rec.salt, kdf: { ...LOGIN_KDF }, bundle: rec.bundle, ...more };
    },
    /**
     * Link a GitHub account to a username here. Both proofs are needed: the relay's assertion that GitHub confirmed the id at a real OAuth callback, and the identity's signature that the person wants it.
     * One GitHub account links one username in a space, and one username one GitHub account.
     * @param {{ username: string, person: string, pub: string, ts: number, sig: string, assertion: string }} input
     */
    async linkGithub(input) {
      const username = String(input && input.username || "").trim().toLowerCase();
      if (!NAME.test(username)) throw fail("bad_input", "Type the username.");
      const who = verifyGithubAssertion(String(input.assertion || ""), String(o.relayPub || ""), o.space, now);
      if (!who) throw fail("denied", "GitHub has not confirmed that account. Sign in with GitHub again.");
      if (Math.abs(now() - Number(input.ts)) > 5 * 60_000) throw fail("expired", "That request is too old. Try again.");
      if (!verifies(String(input.pub), githubLinkMessage(o.space, username, who.id, Number(input.ts)), String(input.sig))) throw fail("denied", "That request is not signed by the identity.");
      if (!o.verifyIdentity || !(await o.verifyIdentity(String(input.person), String(input.pub)))) throw fail("denied", "That key is not one this person has published.");
      const rec = record(username);
      if (!rec || rec.person !== input.person) throw fail("denied", "That username belongs to someone else, or has no sign-in record here.");
      const held = o.store.get(`gh:${who.id}`);
      if (typeof held === "string" && held !== username) throw fail("denied", "That GitHub account is linked to another username here.");
      if (typeof rec.github === "string" && rec.github !== who.id) throw fail("denied", "This username already has a different GitHub account linked.");
      o.store.set(`gh:${who.id}`, username);
      o.store.set(`login:${username}`, { ...rec, github: who.id });
      return { ok: true, username, login: who.login };
    },
    /**
     * Make a one-time device link for a person who is a member here: the identity key signs the hash of a nonce the device keeps, the space remembers that hash for five minutes. The link itself (the nonce)
     * never reaches the space. At most five live links per person.
     * @param {{ person: string, pub: string, ts: number, exp: number, sig: string, h: string }} input
     */
    async linkMake(input) {
      const person = String(input && input.person || ""), h = String(input && input.h || "");
      if (!/^per_[a-z2-7]{26}$/.test(person) || !/^[A-Za-z0-9_-]{43}$/.test(h)) throw fail("bad_input", "That link request is not in the right shape.");
      const t = now();
      if (Math.abs(t - Number(input.ts)) > 5 * 60_000) throw fail("expired", "That request is too old. Try again.");
      if (Number(input.exp) !== Number(input.ts) + LINK_TTL_MS) throw fail("bad_input", "A device link lasts five minutes.");
      if (!verifies(String(input.pub), linkMakeMessage(o.space, person, h, Number(input.exp), Number(input.ts)), String(input.sig))) throw fail("denied", "That request is not signed by the identity.");
      if (!o.verifyIdentity || !(await o.verifyIdentity(person, String(input.pub)))) throw fail("denied", "That key is not one this person has published.");
      const username = usernamesOfPerson(person)[0];
      if (!username || (o.isMember && !(await o.isMember(username, person)))) throw fail("denied", "This person has no sign-in here.");
      sweepLinks();
      if ([...links.values()].filter(l => l.person === person && !l.used && l.exp > t).length >= LINK_LIVE_MAX) throw fail("rate_limited", "Too many device links are waiting. Use or wait out one first.");
      links.set(h, { person, username, exp: t + LINK_TTL_MS, used: false });
      return { ok: true, expires: t + LINK_TTL_MS };
    },
    /**
     * Redeem a device link. It is burned on its first presentation, right or wrong, so a second use is "link_used". The new device signs with its own fresh key; it is enrolled as a device of the person, the
     * other devices are told, and it gets the wrapped record and the salt, which only the master password opens.
     * @param {{ nonce?: string, sig?: string, device?: { id?: string, label?: string, pub?: string } }} input @param {string} address
     */
    async linkRedeem(input, address) {
      const wait = lim.wait(`a:${address}`, PER_ADDR, WINDOW);
      if (wait) return tooMany(wait);
      sweepLinks();
      const miss = (/** @type {string} */ code, /** @type {string} */ message) => { lim.hit(`a:${address}`, PER_ADDR, WINDOW); return { error: { code, message } }; };
      const nonce = String(input && input.nonce || "");
      if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return miss("bad_link", "This link is not valid.");
      const h = sha256b64(Buffer.from(nonce, "base64url"));
      const link = links.get(h);
      if (!link) return miss("bad_link", "This link is not valid.");
      if (link.used) return { error: { code: "link_used", message: "This link was already used. Ask for a new one." } };
      link.used = true;
      if (link.exp <= now()) return { error: { code: "link_expired", message: "This link has expired. Ask for a new one." } };
      const dpub = String(input && input.device && input.device.pub || "");
      if (!/^[A-Za-z0-9_-]{43}$/.test(dpub) || !verifies(dpub, linkRedeemMessage(o.space, h, dpub), String(input.sig || ""))) return miss("bad_link", "This link is not valid.");
      const rec = record(link.username);
      if (!rec) return miss("bad_link", "This link is not valid.");
      const session = b64(rnd(32));
      const label0 = String(input.device && input.device.label || "A new device").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
      const dev = seen(rec, link.username, input, label0, address);
      o.store.set(`login:${link.username}`, { ...record(link.username), enrolled: [...(Array.isArray(rec.enrolled) ? rec.enrolled : []), { pub: dpub, id: dev, at: now() }].slice(-20) });
      sessions.set(session, { username: link.username, exp: now() + SESSION_TTL_MS, device: dev, label: label0, at: now() });
      const more = o.describe ? await Promise.resolve(o.describe(link.username, rec)).catch(() => ({})) : {};
      return { ok: true, session, expires: now() + SESSION_TTL_MS, salt: rec.salt, kdf: { ...LOGIN_KDF }, bundle: rec.bundle, ...more };
    },
    /** A person's live sign-in sessions, newest first, last 20: a device id, its label and when. Never the session secret. @param {string} username */
    sessionsOf(username) {
      sweep();
      const u = String(username || "").toLowerCase();
      return [...sessions.values()].filter(x => x.username === u).sort((a, b) => b.at - a.at).slice(0, 20).map(x => ({ device: x.device, label: x.label, at: x.at }));
    },
    /**
     * "Not me": drop every live session of that device id for that username, and forget the id, so its next sign-in is a new device again and rings the others. A session of that device that comes back is
     * unknown. Returns how many sessions ended.
     * @param {string} username @param {string} device
     */
    revokeDevice(username, device) {
      const u = String(username || "").toLowerCase(), d = String(device || "");
      let n = 0;
      for (const [k, x] of sessions) if (x.username === u && x.device === d) { sessions.delete(k); n += 1; }
      const rec = record(u);
      if (rec && Array.isArray(rec.devices) && rec.devices.includes(d)) o.store.set(`login:${u}`, { ...rec, devices: rec.devices.filter((/** @type {string} */ x) => x !== d) });
      return { revoked: n > 0, ended: n };
    },
    /** The username a session belongs to, or null. @param {string} session */
    sessionUser(session) { sweep(); const s = sessions.get(String(session)); return s ? s.username : null; },
    has: (/** @type {string} */ username) => Boolean(record(String(username).toLowerCase())),
  };
}

/** A public key nobody holds the private half of: what an unknown username is checked against, so a miss costs the same as a wrong password. @param {Buffer} secret */
function deriveDummy(secret) {
  const seed = crypto.createHmac("sha256", secret).update("dummy-login-key").digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  return b64(crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
}
