// @ts-check
// crypto — every primitive the Vault uses, from node:crypto and nothing else.
//
// The reasoning for each choice is in docs/adr/0001-vault-crypto.md and, for v2, in
// docs/adr/0006-vault-next.md decision 1. In short: a device key opens the agent vault's key
// (VK), an account unlock key (AUK, from the password and the Secret Key) opens the personal
// vault's key, and each item version has its own random item key (IK) wrapped under its VK.
// AES-256-GCM everywhere, Argon2id (or scrypt) for a password, HMAC over metadata rows, Ed25519
// to sign relay requests and X25519 to seal an item for another person's Vyre. Keys are held as
// KeyObjects where node takes them, so raw bytes stay out of the JS heap. The v1 functions stay
// so old items can be opened once and re-sealed. Nothing here touches the disk.

import crypto from "node:crypto";

const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Buffer.from(String(s), "base64");

/** A fresh 32-byte master key. */
export const newMasterKey = () => crypto.randomBytes(32);

/** Raw bytes to a KeyObject, zeroing the bytes: the caller must not use them again. @param {Buffer} buf */
export function keyObject(buf) {
  const k = crypto.createSecretKey(Buffer.from(buf));
  buf.fill(0);
  return k;
}

/** The 32 bytes of a hex key, decoded byte by byte into a buffer we can zero (no hex copies). */
export function fromHex(hex) {
  const s = String(hex);
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("not a 32-byte hex key");
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Stable JSON: keys sorted at every level, so a signature covers the same bytes on both ends. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

/** @param {crypto.KeyObject|Buffer} key @param {Buffer|string} plaintext @param {string} aad */
function gcmSeal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

function gcmOpen(key, { iv, tag, ct }, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(tag));
  return Buffer.concat([d.update(unb64(ct)), d.final()]);
}

const itemKey = (mk, id) => Buffer.from(crypto.hkdfSync("sha256", mk, Buffer.from(String(id)), "vyre vault item v1", 32));
const itemAad = (id, name) => `vyre:item:v1:${id}:${name}`;

/**
 * Seal one item's fields. The id and name are bound in, so a sealed file moved into another
 * item's slot fails to open rather than decrypting into the wrong grant.
 * @param {Buffer} mk @param {string} id @param {string} name @param {any} fields
 */
export function sealItem(mk, id, name, fields) {
  return { v: 1, alg: "A256GCM", ...gcmSeal(itemKey(mk, id), JSON.stringify(fields), itemAad(id, name)) };
}

/** Open one item's fields. Throws if the key, id, name or bytes are wrong. */
export function openItem(mk, id, name, sealed) {
  if (!sealed || sealed.v !== 1 || sealed.alg !== "A256GCM") throw new Error("not a sealed vault item");
  return JSON.parse(gcmOpen(itemKey(mk, id), sealed, itemAad(id, name)).toString("utf8"));
}

/** scrypt at N=2^17, r=8, p=1 needs 128 MB; maxmem has to allow it. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const scrypt = (pass, salt, o) => crypto.scryptSync(String(pass).normalize("NFKC"), salt, 32, { ...o, maxmem: 256 * o.N * o.r + 64 * 1024 * 1024 });

/**
 * Stored scrypt parameters, clamped, so a file someone edited cannot make a guess cheap
 * (ADR 0006 finding 10): N from 2^17 to 2^20 and a power of two, r = 8, p from 1 to 4.
 * `floor` lowers the minimum N for tests only; nothing outside a test passes it.
 */
export function clampScrypt({ N, r, p }, floor = SCRYPT.N) {
  const n = Number(N), pp = Number(p);
  if (!Number.isInteger(n) || (n & (n - 1)) !== 0 || n < floor || n > 1 << 20) throw new Error("the stored scrypt cost is outside what this vault allows");
  if (Number(r) !== 8 || !Number.isInteger(pp) || pp < 1 || pp > 4) throw new Error("the stored scrypt cost is outside what this vault allows");
  return { N: n, r: 8, p: pp };
}

/** Wrap the master key under a passphrase, for the passphrase keystore. */
export function wrapKey(passphrase, mk, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  return { v: 1, kdf: "scrypt", ...params, salt: b64(salt), ...gcmSeal(scrypt(passphrase, salt, params), mk, "vyre:mk:v1") };
}

/** Unwrap it. A wrong passphrase throws, and says so in words. */
export function unwrapKey(passphrase, w) {
  if (!w || w.v !== 1 || w.kdf !== "scrypt") throw new Error("not a wrapped vault key");
  const params = clampScrypt(w);
  try { return gcmOpen(scrypt(passphrase, unb64(w.salt), params), w, "vyre:mk:v1"); }
  catch { throw new Error("that passphrase does not open this vault"); }
}

/** A device identity: Ed25519 to sign relay requests, X25519 to receive sealed items. DER, base64. */
export function newIdentity() {
  const s = crypto.generateKeyPairSync("ed25519"), x = crypto.generateKeyPairSync("x25519");
  const pub = k => b64(k.export({ format: "der", type: "spki" })), priv = k => b64(k.export({ format: "der", type: "pkcs8" }));
  return { sign: { public: pub(s.publicKey), private: priv(s.privateKey) }, box: { public: pub(x.publicKey), private: priv(x.privateKey) } };
}

const pubKey = der => crypto.createPublicKey({ key: unb64(der), format: "der", type: "spki" });
const privKey = der => crypto.createPrivateKey({ key: unb64(der), format: "der", type: "pkcs8" });

/** Sign a value (its canonical JSON). */
export const sign = (privDer, value) => b64(crypto.sign(null, Buffer.from(canonical(value)), privKey(privDer)));

/** Check a signature. Never throws: a malformed key or signature is simply not valid. */
export function verify(pubDer, value, sig) {
  try { return crypto.verify(null, Buffer.from(canonical(value)), pubKey(pubDer), unb64(sig)); } catch { return false; }
}

/** An X25519 shared secret, refused when it is all zeros (a low-order public key). */
function shared(privateKey, publicKey) {
  const s = crypto.diffieHellman({ privateKey, publicKey });
  if (s.every(b => b === 0)) throw new Error("refused a key that gives an all-zero shared secret");
  return s;
}

/** The v2 wrap key: salt binds both public keys, info binds the purpose. */
function wrapKeyV2(sharedSecret, epk, recipientPub, purpose) {
  const k = keyObject(Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.concat([epk, recipientPub]), `vyre wrap v2:${purpose}`, 32)));
  sharedSecret.fill(0);
  return k;
}

/**
 * Seal a value for one recipient's X25519 key (ECIES v2, ADR 0006 decision 1): an ephemeral
 * key, HKDF over the shared secret salted with the ephemeral and the recipient's public keys
 * (so the recipient is bound) and labelled with the purpose, and AES-256-GCM with the version
 * and the caller's AAD. An all-zero shared secret is refused.
 * @param {string} boxPubDer @param {any} value @param {string} aad @param {string} [purpose]
 */
export function sealFor(boxPubDer, value, aad, purpose = "pass") {
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "der", type: "spki" });
  const rpub = pubKey(boxPubDer).export({ format: "der", type: "spki" });
  const key = wrapKeyV2(shared(eph.privateKey, pubKey(boxPubDer)), epk, rpub, purpose);
  return { v: 2, purpose, epk: b64(epk), ...gcmSeal(key, JSON.stringify(value), `vyre:wrap:v2:${purpose}:${aad}`) };
}

/**
 * Open what sealFor made, with the recipient's private key and the same AAD. v1 (tickets made
 * before ADR 0006) still opens, so a pass someone sent earlier can be accepted.
 */
export function openFrom(boxPrivDer, sealed, aad, purpose = "pass") {
  if (!sealed || typeof sealed !== "object") throw new Error("not a sealed value");
  const priv = privKey(boxPrivDer);
  if (sealed.v === 1) {
    const key = Buffer.from(crypto.hkdfSync("sha256", shared(priv, pubKey(sealed.epk)), unb64(sealed.epk), "vyre pass seal v1", 32));
    return JSON.parse(gcmOpen(key, sealed, aad).toString("utf8"));
  }
  if (sealed.v !== 2 || sealed.purpose !== purpose) throw new Error("not a sealed value for this purpose");
  const rpub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" });
  const key = wrapKeyV2(shared(priv, pubKey(sealed.epk)), unb64(sealed.epk), rpub, purpose);
  return JSON.parse(gcmOpen(key, sealed, `vyre:wrap:v2:${purpose}:${aad}`).toString("utf8"));
}

/** Compare two strings in constant time (for tokens and nonces, never for values). */
export function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- v2: vault keys, item keys, row MACs ---------------------------------------------------

/** Wrap a vault key (VK) under a device key or an account unlock key. */
export function wrapVaultKey(wrapping, vk, aad) {
  const raw = vk.export();
  try { return { v: 2, ...gcmSeal(wrapping, raw, aad) }; } finally { raw.fill(0); }
}

/** Unwrap it into a KeyObject. Throws if the wrapping key or the label is wrong. */
export function unwrapVaultKey(wrapping, w, aad) {
  if (!w || w.v !== 2) throw new Error("not a wrapped vault key");
  return keyObject(gcmOpen(wrapping, w, aad));
}

/** A fresh vault key, as a KeyObject. */
export const newVaultKey = () => keyObject(crypto.randomBytes(32));

export const ikAad = ({ vault, kv, id, ver }) => `vyre:ik:v2:${vault}:${kv}:${id}:${ver}`;
export const bodyAad = ({ vault, id, ver, name }) => `vyre:item:v2:${vault}:${id}:${ver}:${name}`;

/**
 * Seal one item version (v2): a fresh random item key, wrapped under the vault key with the
 * vault, key version, id and item version in its AAD; the body `{ meta, fields }` under the
 * item key with the vault, id, version and name in its AAD. An older file put back fails,
 * because its version is not the one the (MACed) row names.
 * @param {crypto.KeyObject} vk
 * @param {{ vault: string, kv: number, id: string, ver: number, name: string }} at
 * @param {{ meta: any, fields: any }} body
 */
export function sealItemV2(vk, at, body) {
  const raw = crypto.randomBytes(32);
  try {
    const ik = gcmSeal(vk, raw, ikAad(at));
    const sealedBody = gcmSeal(raw, JSON.stringify({ meta: body.meta, fields: body.fields }), bodyAad(at));
    return { v: 2, alg: "A256GCM", vault: at.vault, kv: at.kv, ver: at.ver, ik, body: sealedBody };
  } finally { raw.fill(0); }
}

/**
 * Open one v2 item. `at` comes from the vyre.db row, never from the file, so a file from
 * another slot, vault or version fails. Returns `{ meta, fields }`.
 */
export function openItemV2(vk, at, sealed) {
  if (!sealed || sealed.v !== 2 || sealed.alg !== "A256GCM") throw new Error("not a v2 sealed vault item");
  if (sealed.vault !== at.vault || sealed.ver !== at.ver || sealed.kv !== at.kv) throw new Error("this sealed item is not the version its row names");
  const raw = gcmOpen(vk, sealed.ik, ikAad(at));
  try { return JSON.parse(gcmOpen(raw, sealed.body, bodyAad(at)).toString("utf8")); }
  finally { raw.fill(0); }
}

/** The key that MACs metadata rows, from the agent vault key. */
export const macKey = vk => keyObject(Buffer.from(crypto.hkdfSync("sha256", vk, Buffer.alloc(0), "vyre vault meta v1", 32)));

/** MAC over one row's fields that matter, with the table in it so rows cannot swap tables. */
export const rowMac = (key, table, fields) => crypto.createHmac("sha256", key).update(canonical({ table, ...fields })).digest("base64");

// ---- v2: the account unlock key and the Secret Key ------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function unbase32(s, bytes) {
  const out = Buffer.alloc(bytes);
  let bits = 0, val = 0, i = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("not base32");
    val = ((val << 5) | v) & 0xffff; bits += 5;
    if (bits >= 8) { if (i < bytes) out[i++] = (val >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out;
}

/** A new account id: six base32 characters. */
export const newAccountId = () => base32(crypto.randomBytes(4)).slice(0, 6);

const skCheck = (acct, bytes) => base32(crypto.createHash("sha256").update(`vyre sk v2:${acct}:`).update(bytes).digest()).slice(0, 2);

/**
 * A Secret Key as people write it: `V2-<acct>-<26 base32>-<2 check>`. The 26 characters carry
 * 128 random bits; the two check characters (10 bits of a hash) catch a mistyped kit.
 * @param {string} acct @param {Buffer} bytes 16 bytes
 */
export function formatSecretKey(acct, bytes) {
  if (!/^[A-Z2-7]{6}$/.test(acct) || bytes.length !== 16) throw new Error("not a Secret Key");
  return `V2-${acct}-${base32(bytes)}-${skCheck(acct, bytes)}`;
}

/** Read a Secret Key back. Case, spaces and dashes do not matter; a wrong checksum throws. */
export function parseSecretKey(text) {
  const s = String(text ?? "").toUpperCase().replace(/[\s-]/g, "");
  const m = /^V2([A-Z2-7]{6})([A-Z2-7]{26})([A-Z2-7]{2})$/.exec(s);
  if (!m) throw new Error("that is not a Vyre Secret Key (V2-XXXXXX-...)");
  const bytes = unbase32(m[2], 16);
  if (base32(bytes) !== m[2] || skCheck(m[1], bytes) !== m[3]) { bytes.fill(0); throw new Error("that Secret Key has a typo: its check characters do not match"); }
  return { acct: m[1], bytes };
}

/** The password KDF's defaults (ADR 0006): Argon2id m = 64 MiB, t = 3, p = 4, or scrypt. */
export const ARGON2 = { m: 65536, t: 3, p: 4 };
export const AUK_SCRYPT = { N: 1 << 17, r: 8, p: 1 };
export const MIN_PASSWORD = 12;

/** Which KDF runs here: Argon2id where node has it (24.7+), scrypt otherwise. */
export const passwordKdf = () => (typeof (/** @type {any} */ (crypto)).argon2Sync === "function" ? "argon2id" : "scrypt");

/**
 * Stored KDF parameters, clamped so a tampered file cannot weaken them. `test` is the one way
 * to go lower, and only a test passes it.
 * @param {any} rec @param {{ test?: boolean }} [o]
 */
export function clampKdf(rec, { test = false } = {}) {
  if (rec.kdf === "argon2id") {
    const m = Number(rec.m), t = Number(rec.t), p = Number(rec.p);
    const minM = test ? 256 : ARGON2.m, minT = test ? 1 : ARGON2.t;
    if (!Number.isInteger(m) || m < minM || m > 4 * 1024 * 1024 || !Number.isInteger(t) || t < minT || t > 16 || !Number.isInteger(p) || p < 1 || p > 16) {
      throw new Error("the stored password cost is outside what this vault allows");
    }
    return { kdf: "argon2id", m, t, p };
  }
  if (rec.kdf === "scrypt") return { kdf: "scrypt", ...clampScrypt(rec, test ? 1 << 10 : AUK_SCRYPT.N) };
  throw new Error("unknown password KDF");
}

/** The password half: Argon2id or scrypt over NFKC(password). @returns {Buffer} */
function passwordKey(password, salt, params) {
  const pw = Buffer.from(String(password).normalize("NFKC"), "utf8");
  try {
    if (params.kdf === "argon2id") {
      return /** @type {any} */ (crypto).argon2Sync("argon2id", { message: pw, nonce: salt, parallelism: params.p, tagLength: 32, memory: params.m, passes: params.t });
    }
    return crypto.scryptSync(pw, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 64 * 1024 * 1024 });
  } finally { pw.fill(0); }
}

/**
 * AUK = HKDF(kdf(password), acct, "vyre auk v2") XOR HKDF(secretKey, acct, "vyre sk v2").
 * Both halves are needed: a stolen disk with a weak password still faces the 128-bit Secret Key.
 * @param {{ password: string, secretKey: Buffer, acct: string, salt: Buffer, params: any }} o
 * @returns {crypto.KeyObject}
 */
export function accountUnlockKey({ password, secretKey, acct, salt, params }) {
  const pk = passwordKey(password, salt, params);
  const a = Buffer.from(crypto.hkdfSync("sha256", pk, Buffer.from(acct), "vyre auk v2", 32));
  const b = Buffer.from(crypto.hkdfSync("sha256", secretKey, Buffer.from(acct), "vyre sk v2", 32));
  pk.fill(0);
  for (let i = 0; i < 32; i++) a[i] ^= b[i];
  b.fill(0);
  return keyObject(a);
}
