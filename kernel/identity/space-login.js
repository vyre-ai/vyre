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
  /** @type {Map<string, { n: number, at: number, until: number, strikes: number }>} */ const m = new Map();
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
      if (!e) { e = { n: 0, at: t, until: 0, strikes: 0 }; m.set(key, e); }
      if (t - e.at > windowMs) { e.n = 0; e.at = t; }
      e.n += 1;
      if (e.n >= max) { e.strikes += 1; e.until = t + Math.min(15 * 60_000, 15_000 * 2 ** (e.strikes - 1)); e.n = 0; e.at = t; }
      if (m.size > 20_000) for (const [k, v] of m) if (v.until < t && t - v.at > windowMs) m.delete(k);
    },
    clear(/** @type {string} */ key) { m.delete(key); },
  };
}

/**
 * The server side for one space. State that must survive a restart (records) goes through `store`; challenges, sessions and counters are memory only.
 * @param {{ space: string, store: { get: (k: string) => any, set: (k: string, v: any) => void }, secret?: Buffer, now?: () => number, random?: (n: number) => Buffer,
 *   isMember?: (username: string) => boolean | Promise<boolean>, verifyIdentity?: (person: string, pub: string) => Promise<boolean>, onNewDevice?: (e: { username: string, label: string, address: string, at: number }) => void }} o
 */
export function createLoginService(o) {
  const now = o.now || Date.now;
  const rnd = o.random || (n => crypto.randomBytes(n));
  const secret = o.secret || rnd(32);
  const dummy = deriveDummy(secret);
  /** @type {Map<string, { username: string, address: string, exp: number }>} */ const challenges = new Map();
  /** @type {Map<string, { username: string, exp: number }>} */ const sessions = new Map();
  const lim = limiter(now);
  const PER_ADDR = 20, PER_NAME = 5, WINDOW = 60_000, NAME_WINDOW = 15 * 60_000;
  const sweep = () => { const t = now(); for (const [k, c] of challenges) if (c.exp <= t) challenges.delete(k); for (const [k, s] of sessions) if (s.exp <= t) sessions.delete(k); };
  const limited = (/** @type {string} */ username, /** @type {string} */ address) => Math.max(lim.wait(`a:${address}`, PER_ADDR, WINDOW), lim.wait(`n:${username}`, PER_NAME, NAME_WINDOW));
  const tooMany = (/** @type {number} */ s) => ({ error: { code: "rate_limited", message: `Too many tries. Wait ${s} seconds and try again.`, retry: s } });
  const fakeSalt = (/** @type {string} */ username) => b64(crypto.createHmac("sha256", secret).update(`salt\n${username}`).digest().subarray(0, 16));
  const record = (/** @type {string} */ username) => { const r = o.store.get(`login:${username}`); return r && typeof r === "object" ? r : null; };

  return {
    /** Step 1. Always the same shape, whether or not the name exists. */
    begin(/** @type {{ username?: string }} */ input, /** @type {string} */ address) {
      const username = String(input && input.username || "").trim().toLowerCase();
      if (!NAME.test(username)) return { error: { code: "bad_input", message: "Type your username." } };
      const wait = limited(username, address);
      if (wait) return tooMany(wait);
      lim.hit(`a:${address}`, PER_ADDR, WINDOW);
      sweep();
      const rec = record(username);
      const challenge = b64(rnd(32));
      challenges.set(challenge, { username, address, exp: now() + CHALLENGE_TTL_MS });
      return { salt: rec ? rec.salt : fakeSalt(username), kdf: { ...LOGIN_KDF }, challenge, expires: now() + CHALLENGE_TTL_MS };
    },
    /** Step 2. A challenge is spent the first time it is seen, right or wrong. Every failure is the same answer. */
    finish(/** @type {{ username?: string, challenge?: string, sig?: string, device?: { label?: string } }} */ input, /** @type {string} */ address) {
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
      sessions.set(session, { username, exp: now() + SESSION_TTL_MS });
      const label = String(input && input.device && input.device.label || "A new device").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
      try { o.onNewDevice && o.onNewDevice({ username, label, address, at: now() }); } catch { /* the notice failing never blocks the person */ }
      return { ok: true, session, expires: now() + SESSION_TTL_MS, bundle: rec.bundle };
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
      if (o.isMember && !(await o.isMember(username))) throw fail("denied", "That username is not a member of this space.");
      const held = record(username);
      if (held && held.person !== input.person) throw fail("denied", "That username belongs to someone else.");
      o.store.set(`login:${username}`, { person: String(input.person), salt: input.salt, kdf: { ...LOGIN_KDF }, loginPub: input.loginPub, bundle: input.bundle, at: now() });
      return { ok: true, username };
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
