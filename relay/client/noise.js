// @ts-check
// noise: the initiator side of Noise_IK_25519_AESGCM_SHA256 (revision 34) over an async crypto
// provider, so one file runs on WebCrypto in a browser and on injected @noble in React Native.
// Byte for byte the same protocol as core/relay/noise.js (the box side); both are checked against
// the cacophony vector.
//
// The provider (see webcrypto.js and noble.js):
//   generateKeyPair() -> { privateKey: <opaque handle>, publicKey: Uint8Array(32) }
//   dh(privateKey, peerPub) -> Uint8Array(32)
//   sha256(bytes), hmacSha256(key, bytes) -> Uint8Array(32)
//   aesKey?(raw32) -> <opaque AES handle>   (optional; without it the raw bytes are the handle)
//   aesGcmEncrypt(key, nonce12, ad, pt), aesGcmDecrypt(key, nonce12, ad, ct) -> Uint8Array
//   randomBytes(n) -> Uint8Array

import { EMPTY, concat, utf8, isZero } from "./bytes.js";

export const PROTOCOL = "Noise_IK_25519_AESGCM_SHA256";
const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
/** The same ceiling as the box: 2^32 messages per direction, far below the spec's 2^64 - 1. */
export const MAX_NONCE = 2 ** 32;

/**
 * @typedef {{ privateKey: any, publicKey: Uint8Array }} KeyPair
 * @typedef {{
 *   generateKeyPair(): Promise<KeyPair>,
 *   dh(privateKey: any, peerPub: Uint8Array): Promise<Uint8Array>,
 *   sha256(bytes: Uint8Array): Promise<Uint8Array>,
 *   hmacSha256(key: Uint8Array, bytes: Uint8Array): Promise<Uint8Array>,
 *   aesKey?(raw: Uint8Array): Promise<any>,
 *   aesGcmEncrypt(key: any, nonce: Uint8Array, ad: Uint8Array, pt: Uint8Array): Promise<Uint8Array>,
 *   aesGcmDecrypt(key: any, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array): Promise<Uint8Array>,
 *   randomBytes(n: number): Uint8Array | Promise<Uint8Array>,
 *   importKeyPair?(rawPriv: Uint8Array): Promise<KeyPair>,
 * }} CryptoProvider
 */

/** AESGCM's nonce: 32 bits of zeros, then the counter as 64 bits big-endian (spec 12.3). @param {number} n */
export function nonceOf(n) {
  const iv = new Uint8Array(12);
  const v = new DataView(iv.buffer);
  v.setUint32(4, Math.floor(n / 2 ** 32));
  v.setUint32(8, n >>> 0);
  return iv;
}
const REKEY_NONCE = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);

/** @param {CryptoProvider} c @param {Uint8Array} raw */
async function aesHandle(c, raw) {
  if (!c.aesKey) return raw;
  const k = await c.aesKey(raw);
  raw.fill(0);
  return k;
}

/** X25519 through the provider; an all-zero result (a low-order key) is refused, as on the box. */
async function dh(c, priv, pub) {
  if (!(pub instanceof Uint8Array) || pub.length !== DHLEN) throw new Error("an X25519 public key is 32 bytes");
  let out;
  try { out = await c.dh(priv, pub); } catch { throw new Error("invalid peer key"); }
  if (!(out instanceof Uint8Array) || out.length !== DHLEN || isZero(out)) throw new Error("invalid peer key");
  return out;
}

/** The Noise HKDF (spec 4.3), two outputs. @param {CryptoProvider} c */
async function hkdf2(c, ck, ikm) {
  const temp = await c.hmacSha256(ck, ikm);
  const o1 = await c.hmacSha256(temp, new Uint8Array([1]));
  const o2 = await c.hmacSha256(temp, concat(o1, new Uint8Array([2])));
  return [o1, o2];
}

/** One direction's key and counter (spec 5.1). A failed decrypt does not advance the counter. */
export class CipherState {
  /** @param {CryptoProvider} c @param {any} [k] an AES handle from the provider, or null */
  constructor(c, k = null) { this.c = c; this.k = k; this.n = 0; }
  /** @param {CryptoProvider} c @param {Uint8Array} raw */
  static async of(c, raw) { return new CipherState(c, await aesHandle(c, raw)); }
  hasKey() { return this.k !== null; }
  /** @param {Uint8Array} ad @param {Uint8Array} plaintext */
  async encrypt(ad, plaintext) {
    if (this.k === null) return plaintext.slice();
    if (this.n >= MAX_NONCE) throw new Error("channel exhausted; start a new session");
    const n = this.n++;
    return await this.c.aesGcmEncrypt(this.k, nonceOf(n), ad, plaintext);
  }
  /** @param {Uint8Array} ad @param {Uint8Array} ciphertext */
  async decrypt(ad, ciphertext) {
    if (this.k === null) return ciphertext.slice();
    if (this.n >= MAX_NONCE) throw new Error("channel exhausted; start a new session");
    if (ciphertext.length < TAGLEN) throw new Error("decrypt failed");
    let out;
    try { out = await this.c.aesGcmDecrypt(this.k, nonceOf(this.n), ad, ciphertext); } catch { throw new Error("decrypt failed"); }
    this.n++;
    return out;
  }
  /** REKEY (spec 11.3): the next key is the first 32 bytes of the encryption of 32 zeros under nonce 2^64-1. */
  async rekey() {
    if (this.k === null) return;
    const out = await this.c.aesGcmEncrypt(this.k, REKEY_NONCE, EMPTY, new Uint8Array(32));
    this.k = await aesHandle(this.c, out.slice(0, 32));
  }
}

class SymmetricState {
  /** @param {CryptoProvider} c */
  constructor(c) { this.c = c; this.h = EMPTY; this.ck = EMPTY; this.cs = new CipherState(c); }
  async init() {
    const name = utf8(PROTOCOL);
    this.h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : await this.c.sha256(name);
    this.ck = this.h.slice();
  }
  async mixKey(ikm) {
    const [ck, k] = await hkdf2(this.c, this.ck, ikm);
    this.ck = ck;
    this.cs = await CipherState.of(this.c, k);
  }
  async mixHash(data) { this.h = await this.c.sha256(concat(this.h, data)); }
  async encryptAndHash(plaintext) {
    const ct = await this.cs.encrypt(this.h, plaintext);
    await this.mixHash(ct);
    return ct;
  }
  async decryptAndHash(ciphertext) {
    const pt = await this.cs.decrypt(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return pt;
  }
  async split() {
    const [k1, k2] = await hkdf2(this.c, this.ck, EMPTY);
    return [await CipherState.of(this.c, k1), await CipherState.of(this.c, k2)];
  }
}

/**
 * The device's IK handshake: writeMessage once, then readMessage once. After that `done` is true
 * and `send`, `recv` and `hash` are set.
 */
export class Initiator {
  /**
   * @param {CryptoProvider} c
   * @param {{ s: KeyPair, rs: Uint8Array, prologue?: Uint8Array, e?: KeyPair }} o `e` only for test vectors
   */
  constructor(c, o) {
    if (!o.rs) throw new Error("the initiator needs the responder's static key");
    this.c = c;
    this.s = o.s;
    this.rs = o.rs.slice();
    this.e = o.e || null;
    this.prologue = o.prologue || EMPTY;
    this.ss = new SymmetricState(c);
    this.step = 0;
    this.done = false;
    /** @type {CipherState|null} */ this.send = null;
    /** @type {CipherState|null} */ this.recv = null;
    /** @type {Uint8Array|null} */ this.hash = null;
  }

  /** -> e, es, s, ss  @param {Uint8Array} [payload] */
  async writeMessage(payload = EMPTY) {
    if (this.step !== 0) throw new Error("handshake out of order");
    this.step = 1;
    const ss = this.ss;
    await ss.init();
    await ss.mixHash(this.prologue);
    await ss.mixHash(this.rs);
    this.e = this.e || await this.c.generateKeyPair();
    await ss.mixHash(this.e.publicKey);
    await ss.mixKey(await dh(this.c, this.e.privateKey, this.rs));
    const s = await ss.encryptAndHash(this.s.publicKey);
    await ss.mixKey(await dh(this.c, this.s.privateKey, this.rs));
    return concat(this.e.publicKey, s, await ss.encryptAndHash(payload));
  }

  /** <- e, ee, se  @param {Uint8Array} message @returns {Promise<Uint8Array>} the payload */
  async readMessage(message) {
    if (this.step !== 1) throw new Error("handshake out of order");
    if (message.length < DHLEN + TAGLEN) throw new Error("handshake message too short");
    this.step = 2;
    const ss = this.ss;
    const re = message.slice(0, DHLEN);
    await ss.mixHash(re);
    await ss.mixKey(await dh(this.c, /** @type {KeyPair} */ (this.e).privateKey, re));
    await ss.mixKey(await dh(this.c, this.s.privateKey, re));
    const payload = await ss.decryptAndHash(message.subarray(DHLEN));
    const [c1, c2] = await ss.split();
    this.send = c1;
    this.recv = c2;
    this.hash = ss.h;
    this.done = true;
    return payload;
  }
}
