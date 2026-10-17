// @ts-check
// The master password on a device with no Node (kernel/identity/master.js, ADR 0054), the same record in the same bytes: one Argon2id stretch of the password unlocks a root key, the root key wraps
// the identity halves and the member box key, and the recovery key is a second way to the same root key. A record made here opens with kernel/identity/master.js, and one made there opens here (a test
// pins both ways). Everything that comes out of unlock lives in the caller's memory; nothing here stores anything, and a key is only ever kept as these wrapped bytes (never as a CryptoKey).

import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { b64u } from "../../../../kernel/identity/chain.js";

/** RFC 9106's second recommendation, one lane (kernel/identity/master.js MASTER_KDF). */
export const MASTER_KDF = Object.freeze({ memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 });
export const PASSWORD_MIN = 12;

const AAD_PW = "vyre:master:password:v1";
const AAD_RE = "vyre:master:recovery:v1";
const AAD_ID = "vyre:master:identity:v1";
const AAD_BOX = "vyre:master:box:v1";

const enc = new TextEncoder();
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const unb64 = (/** @type {string} */ s) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const rand = (/** @type {number} */ n) => crypto.getRandomValues(new Uint8Array(n));

/** @param {unknown} code */
export const normalizeRecovery = (code) => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");

/** @param {unknown} password */
export function checkPassword(password) {
  const pw = String(password ?? "").normalize("NFKC");
  if (pw.length < PASSWORD_MIN) throw refuse("Choose a master password of at least 12 characters. A phrase of four words works well.", "weak_password");
  if (pw.length > 256) throw refuse("That master password is too long. Choose one of 256 characters or fewer.", "weak_password");
  return pw;
}

/** @param {unknown} code */
export function checkRecovery(code) {
  const n = normalizeRecovery(code);
  if (!/^[a-z2-7]{26}$/.test(n)) throw refuse("That recovery key does not look right. Check it and enter it again on this device.", "bad_recovery");
  return n;
}

/** @param {{ memoryKiB: number, passes: number }} kdf @param {Uint8Array} salt @param {string} password */
const passwordKek = (kdf, salt, password) => argon2idAsync(enc.encode(password), salt, { t: kdf.passes, m: kdf.memoryKiB, p: 1, dkLen: 32, asyncTick: 20 });
/** @param {string} recovery normalized */
const recoveryKek = (recovery) => hkdf(sha256, enc.encode(recovery), enc.encode("vyre-master-recovery"), enc.encode("vyre:master:recovery-ikm:v1"), 32);

/** @param {Uint8Array} kek @param {Uint8Array} plain @param {string} aad */
function wrap(kek, plain, aad) {
  const iv = rand(12);
  const sealed = gcm(kek, iv, enc.encode(aad)).encrypt(plain);
  return { iv: b64u(iv), ct: b64u(sealed.subarray(0, sealed.length - 16)), tag: b64u(sealed.subarray(sealed.length - 16)) };
}

/** @param {Uint8Array} kek @param {{ iv: string, ct: string, tag: string }} box @param {string} aad */
function unwrap(kek, box, aad) {
  const ct = unb64(box.ct), tag = unb64(box.tag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct); joined.set(tag, ct.length);
  return gcm(kek, unb64(box.iv), enc.encode(aad)).decrypt(joined);
}

/**
 * Make the master record. `privateKey` and `agreePrivate` are the identity halves as base64url (agree may be null). With `kek` and `salt` given (the sign-in key K the caller already stretched from this
 * password and salt, login-web.js), no second Argon2id runs: K is the password wrap's key, as in kernel/identity/space-login.js.
 * @param {{ username: string, id: string, password: string, recoveryCode: string, privateKey: string, agreePrivate?: string | null, kdf?: { memoryKiB: number, passes: number }, salt?: Uint8Array, kek?: Uint8Array }} o
 */
export async function createMasterRecord(o) {
  const password = checkPassword(o.password);
  const recovery = checkRecovery(o.recoveryCode);
  const kdf = { ...MASTER_KDF, ...(o.kdf || {}), lanes: 1, tagLength: 32 };
  const salt = o.salt || rand(16);
  const kek = o.kek ? Uint8Array.from(o.kek) : await passwordKek(kdf, salt, password);
  const rk = rand(32);
  const boxPriv = rand(32);
  const rec = {
    v: 1,
    username: o.username,
    id: o.id,
    discoverable: false,
    kdf: { memoryKiB: kdf.memoryKiB, passes: kdf.passes, lanes: 1, tagLength: 32, salt: b64u(salt) },
    passwordWrap: wrap(kek, rk, AAD_PW),
    recoveryWrap: wrap(recoveryKek(recovery), rk, AAD_RE),
    identityWrap: wrap(rk, enc.encode(JSON.stringify({ privateKey: o.privateKey, agreePrivate: o.agreePrivate || null })), AAD_ID),
    vaultWrap: null,
    boxWrap: wrap(rk, boxPriv, AAD_BOX),
    box: { pub: b64u(x25519.getPublicKey(boxPriv)) },
    github: null,
    migratedFrom: null,
    createdAt: Date.now(),
  };
  kek.fill(0); rk.fill(0); boxPriv.fill(0);
  return rec;
}

/**
 * Open a master record with the password or the recovery key. Returns the identity halves for the caller to hold in memory; a wrong secret is `bad_password` or `bad_recovery`.
 * @param {any} rec @param {{ password?: string, recovery?: string, kek?: Uint8Array }} o (`kek`: the key already stretched from the password, so no second Argon2id runs)
 * @returns {Promise<{ privateKey: string, agreePrivate: string | null }>}
 */
export async function openMasterRecord(rec, o) {
  if (!rec || rec.v !== 1) throw refuse("There is no master password on this device yet. Create your username first.", "no_identity");
  /** @type {Uint8Array} */ let rk;
  if (o.kek) {
    try { rk = unwrap(o.kek, rec.passwordWrap, AAD_PW); }
    catch { throw refuse("That password does not unlock this identity. Try again, or enter your recovery key on this device.", "bad_password"); }
  } else if (o.recovery) {
    const recovery = checkRecovery(o.recovery);
    try { rk = unwrap(recoveryKek(recovery), rec.recoveryWrap, AAD_RE); }
    catch { throw refuse("That recovery key does not unlock this identity. Check it and enter it again on this device.", "bad_recovery"); }
  } else {
    const password = checkPassword(o.password);
    const kek = await passwordKek(rec.kdf, unb64(rec.kdf.salt), password);
    try { rk = unwrap(kek, rec.passwordWrap, AAD_PW); }
    catch { throw refuse("That password does not unlock this identity. Try again, or enter your recovery key on this device.", "bad_password"); }
    finally { kek.fill(0); }
  }
  try {
    const id = JSON.parse(new TextDecoder().decode(unwrap(rk, rec.identityWrap, AAD_ID)));
    return { privateKey: String(id.privateKey), agreePrivate: id.agreePrivate ? String(id.agreePrivate) : null };
  } finally { rk.fill(0); }
}
