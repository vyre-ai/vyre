// @ts-check
// Sign in from any device, the page's half (kernel/identity/space-login.js is the server's and the daemon's; the bytes are the same, a test pins them): ask <space>.vyre.run for the username's salt and
// KDF, stretch the password HERE with Argon2id into K, sign the single-use challenge with the login key made from K, and open the returned master record with K. The password and K never leave
// the page. Argon2id is @noble/hashes' async version (byte-identical to Node's, the page's only Argon2id), so the page keeps responding while it runs.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u } from "../../../../kernel/identity/chain.js";

export const LOGIN_TAG = "vyre-login-v1";
export const REGISTER_TAG = "vyre-login-register-v1";
/** The cost every record is made with (kernel/identity/space-login.js LOGIN_KDF). */
export const LOGIN_KDF = Object.freeze({ memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 });
/** What a device accepts from a server: below the floor a hostile server could cheapen guessing, above the ceiling it could make the device burn memory. */
export const KDF_FLOOR = Object.freeze({ memoryKiB: 19456, passes: 2 });
export const KDF_CEIL = Object.freeze({ memoryKiB: 262144, passes: 6 });

const enc = new TextEncoder();
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/** A server-supplied KDF is refused outside the floor and ceiling. @param {any} kdf */
export function acceptKdf(kdf) {
  const k = kdf && typeof kdf === "object" ? kdf : {};
  const ok = Number.isInteger(k.memoryKiB) && Number.isInteger(k.passes) && k.lanes === 1 && k.tagLength === 32
    && k.memoryKiB >= KDF_FLOOR.memoryKiB && k.memoryKiB <= KDF_CEIL.memoryKiB && k.passes >= KDF_FLOOR.passes && k.passes <= KDF_CEIL.passes;
  if (!ok) throw fail("bad_kdf", "This server asked for password settings that are too weak or too heavy. Nothing was sent. Check the space address.");
  return { memoryKiB: k.memoryKiB, passes: k.passes, lanes: 1, tagLength: 32 };
}

/** The bytes a device signs to log in. @param {string} space @param {string} username @param {string} challenge */
export const loginMessage = (space, username, challenge) => enc.encode(`${LOGIN_TAG}\n${space}\n${username}\n${challenge}`);

/** What the identity key signs to register or replace a login record. */
export const registerMessage = (/** @type {string} */ space, /** @type {string} */ username, /** @type {string} */ loginPub, /** @type {string} */ bundleHash, /** @type {number} */ ts) => enc.encode(`${REGISTER_TAG}\n${space}\n${username}\n${loginPub}\n${bundleHash}\n${ts}`);

/** sha256 of the bundle's JSON, base64url (the server's bundleHash). @param {any} bundle */
export const bundleHash = (bundle) => b64u(sha256(enc.encode(JSON.stringify(bundle))));

/**
 * K, the login key pair, and nothing the server must not have. `K` is for opening the master record; the caller zeroes it.
 * @param {string} password already NFKC-normalised @param {Uint8Array | string} salt raw bytes, or base64url @param {{ memoryKiB: number, passes: number }} kdf
 */
export async function deriveLogin(password, salt, kdf) {
  const saltBytes = typeof salt === "string" ? unb64(salt) : salt;
  const K = await argon2idAsync(enc.encode(password), saltBytes, { t: kdf.passes, m: kdf.memoryKiB, p: 1, dkLen: 32, asyncTick: 20 });
  const seed = hkdf(sha256, K, enc.encode("vyre-login-seed-v1"), enc.encode("vyre:login:seed:v1"), 32);
  const loginPub = b64u(ed25519.getPublicKey(seed));
  return { K, loginPub, sign: (/** @type {Uint8Array} */ msg) => { const sig = b64u(ed25519.sign(msg, seed)); return sig; }, close: () => { K.fill(0); seed.fill(0); } };
}
