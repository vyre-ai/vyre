// @ts-check
// noise: Noise_IK_25519_AESGCM_SHA256 (the Noise Protocol Framework, revision 34), in node:crypto
// alone. The relay channel (ADR 0026) runs it so both ends prove a long-term key, each direction
// has its own key with a counter nonce (a replayed, reordered or reflected frame fails), and the
// ephemeral-ephemeral DH keeps recorded sessions closed if box.key is stolen later.
//
// IK:  <- s
//      ...
//      -> e, es, s, ss
//      <- e, ee, se
//
// The device is the initiator: it knows the box's static key from the QR code. The box learns
// the device's static key from the first message, encrypted. Checked against the cacophony test
// vector for this exact protocol name (noise.test.js).

import crypto from "node:crypto";

export const PROTOCOL = "Noise_IK_25519_AESGCM_SHA256";
const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
/** 2^64 - 1 is reserved (spec 5.1); we stop far earlier, at 2^32 messages per direction. */
export const MAX_NONCE = 2 ** 32;
const EMPTY = Buffer.alloc(0);

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

const privateKey = raw => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicKey = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });

/**
 * An X25519 key pair as raw 32-byte buffers. With `priv`, its public half; without, a new one.
 * @param {Buffer} [priv]
 * @returns {{ priv: Buffer, pub: Buffer }}
 */
export function keyPair(priv) {
  if (priv) {
    if (priv.length !== DHLEN) throw new Error("an X25519 private key is 32 bytes");
    const pub = crypto.createPublicKey(privateKey(priv)).export({ format: "der", type: "spki" }).subarray(-DHLEN);
    return { priv: Buffer.from(priv), pub: Buffer.from(pub) };
  }
  const k = crypto.generateKeyPairSync("x25519");
  return {
    priv: Buffer.from(k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-DHLEN)),
    pub: Buffer.from(k.publicKey.export({ format: "der", type: "spki" }).subarray(-DHLEN)),
  };
}

/** X25519. An all-zero result (a low-order public key) is refused, as the spec allows. */
export function dh(priv, pub) {
  if (pub.length !== DHLEN) throw new Error("an X25519 public key is 32 bytes");
  let out;
  // OpenSSL refuses an all-zero result itself; either way it is the same refusal.
  try { out = crypto.diffieHellman({ privateKey: privateKey(priv), publicKey: publicKey(pub) }); } catch { throw new Error("invalid peer key"); }
  if (crypto.timingSafeEqual(out, Buffer.alloc(DHLEN))) throw new Error("invalid peer key");
  return out;
}

const hash = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
const hmac = (key, ...parts) => crypto.createHmac("sha256", key).update(Buffer.concat(parts)).digest();

/** The Noise HKDF (spec 4.3), two or three outputs. */
function hkdf(ck, ikm, n = 2) {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, o1, Buffer.from([2]));
  return n === 2 ? [o1, o2] : [o1, o2, hmac(temp, o2, Buffer.from([3]))];
}

/** AESGCM's nonce: 32 bits of zeros, then the counter as 64 bits big-endian (spec 12.3). */
function nonceOf(n) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(n), 4);
  return iv;
}

function seal(k, n, ad, plaintext) {
  const c = crypto.createCipheriv("aes-256-gcm", k, nonceOf(n));
  c.setAAD(ad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

function open(k, n, ad, ciphertext) {
  if (ciphertext.length < TAGLEN) throw new Error("decrypt failed");
  const d = crypto.createDecipheriv("aes-256-gcm", k, nonceOf(n));
  d.setAAD(ad);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  try {
    return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), d.final()]);
  } catch {
    throw new Error("decrypt failed");
  }
}

/** One direction's key and counter (spec 5.1). A failed decrypt does not advance the counter. */
export class CipherState {
  /** @param {Buffer|null} [k] */
  constructor(k = null) { this.k = k; this.n = 0; }
  hasKey() { return this.k !== null; }
  /** @param {Buffer} ad @param {Buffer} plaintext */
  encrypt(ad, plaintext) {
    if (!this.k) return Buffer.from(plaintext);
    if (this.n >= MAX_NONCE) throw new Error("channel exhausted; start a new session");
    const out = seal(this.k, this.n, ad, plaintext);
    this.n++;
    return out;
  }
  /** @param {Buffer} ad @param {Buffer} ciphertext */
  decrypt(ad, ciphertext) {
    if (!this.k) return Buffer.from(ciphertext);
    if (this.n >= MAX_NONCE) throw new Error("channel exhausted; start a new session");
    const out = open(this.k, this.n, ad, ciphertext);
    this.n++;
    return out;
  }
  /** REKEY (spec 11.3): the next key is the encryption of 32 zeros under nonce 2^64-1. */
  rekey() {
    if (!this.k) return;
    const c = crypto.createCipheriv("aes-256-gcm", this.k, Buffer.from("00000000ffffffffffffffff", "hex"));
    this.k = Buffer.concat([c.update(Buffer.alloc(32)), c.final()]).subarray(0, 32);
  }
}

class SymmetricState {
  constructor() {
    const name = Buffer.from(PROTOCOL);
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : hash(name);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState();
  }
  mixKey(ikm) {
    const [ck, k] = hkdf(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState(k);
  }
  mixHash(data) { this.h = hash(this.h, data); }
  encryptAndHash(plaintext) {
    const c = this.cs.encrypt(this.h, plaintext);
    this.mixHash(c);
    return c;
  }
  decryptAndHash(ciphertext) {
    const p = this.cs.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }
  split() {
    const [k1, k2] = hkdf(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

/**
 * One IK handshake. The initiator writes then reads; the responder reads then writes. After the
 * second message, `done` is true and `send`, `recv` and `hash` are set.
 */
export class Handshake {
  /**
   * @param {{ initiator: boolean, s: { pub: Buffer, priv?: Buffer, dh?: (remotePub: Buffer) => Buffer | Promise<Buffer> }, rs?: Buffer, prologue?: Buffer,
   *   e?: { priv: Buffer, pub: Buffer } }} o `rs` is required of the initiator; `e` only for test vectors. A static key is
   *   its private bytes, or a `dh` that answers for them (vyre-core holds the bytes, so its `dh` is async): then read
   *   with readMessageAsync, and the initiator's first write needs the private bytes.
   */
  constructor(o) {
    if (o.initiator && !o.rs) throw new Error("the initiator needs the responder's static key");
    this.initiator = o.initiator;
    this.s = o.s;
    /** The static key's Diffie-Hellman: from its bytes, or the holder's own answer (possibly a promise). @type {(p: Buffer) => Buffer | Promise<Buffer>} */
    this.sdh = o.s.dh ? o.s.dh : p => dh(/** @type {Buffer} */ (o.s.priv), p);
    this.e = o.e || null;
    /** @type {Buffer|null} the peer's static key: known up front to the initiator, learned by the responder */
    this.rs = o.rs ? Buffer.from(o.rs) : null;
    /** @type {Buffer|null} */
    this.re = null;
    this.ss = new SymmetricState();
    this.ss.mixHash(o.prologue || EMPTY);
    this.ss.mixHash(o.initiator ? /** @type {Buffer} */ (this.rs) : this.s.pub);
    this.step = 0;
    this.done = false;
    /** @type {CipherState|null} */ this.send = null;
    /** @type {CipherState|null} */ this.recv = null;
    /** @type {Buffer|null} */ this.hash = null;
  }

  /** @param {Buffer} [payload] */
  writeMessage(payload = EMPTY) {
    const ss = this.ss;
    if (this.initiator && this.step === 0) {
      this.e = this.e || keyPair();
      ss.mixHash(this.e.pub);
      ss.mixKey(dh(this.e.priv, /** @type {Buffer} */ (this.rs)));
      const s = ss.encryptAndHash(this.s.pub);
      ss.mixKey(this.sdhSync(/** @type {Buffer} */ (this.rs)));
      const out = Buffer.concat([this.e.pub, s, ss.encryptAndHash(payload)]);
      this.step = 1;
      return out;
    }
    if (!this.initiator && this.step === 1) {
      this.e = this.e || keyPair();
      ss.mixHash(this.e.pub);
      ss.mixKey(dh(this.e.priv, /** @type {Buffer} */ (this.re)));
      ss.mixKey(dh(this.e.priv, /** @type {Buffer} */ (this.rs)));
      const out = Buffer.concat([this.e.pub, ss.encryptAndHash(payload)]);
      this.finish();
      return out;
    }
    throw new Error("handshake out of order");
  }

  /** The static key's DH where an answer cannot wait. @param {Buffer} pub */
  sdhSync(pub) {
    const r = this.sdh(pub);
    if (r instanceof Promise) { r.catch(() => {}); throw new Error("this static key answers asynchronously; use readMessageAsync"); }
    return r;
  }

  /** One read, written once: each static-key DH is yielded to the driver, which answers it now or later. @param {Buffer} message */
  *reading(message) {
    const ss = this.ss;
    if (!this.initiator && this.step === 0) {
      if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) throw new Error("handshake message too short");
      this.re = Buffer.from(message.subarray(0, DHLEN));
      ss.mixHash(this.re);
      ss.mixKey(yield this.re);
      this.rs = ss.decryptAndHash(message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
      ss.mixKey(yield this.rs);
      const payload = ss.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
      this.step = 1;
      return payload;
    }
    if (this.initiator && this.step === 1) {
      if (message.length < DHLEN + TAGLEN) throw new Error("handshake message too short");
      this.re = Buffer.from(message.subarray(0, DHLEN));
      ss.mixHash(this.re);
      ss.mixKey(dh(/** @type {any} */ (this.e).priv, this.re));
      ss.mixKey(yield this.re);
      const payload = ss.decryptAndHash(message.subarray(DHLEN));
      this.finish();
      return payload;
    }
    throw new Error("handshake out of order");
  }

  /** @param {Buffer} message @returns {Buffer} the payload */
  readMessage(message) {
    const g = this.reading(message);
    let r = g.next();
    while (!r.done) r = g.next(this.sdhSync(r.value));
    return r.value;
  }

  /** As readMessage, for a static key whose DH is answered by its holder. @param {Buffer} message @returns {Promise<Buffer>} the payload */
  async readMessageAsync(message) {
    const g = this.reading(message);
    let r = g.next();
    while (!r.done) r = g.next(await this.sdh(r.value));
    return r.value;
  }

  finish() {
    const [c1, c2] = this.ss.split();
    this.send = this.initiator ? c1 : c2;
    this.recv = this.initiator ? c2 : c1;
    this.hash = this.ss.h;
    this.done = true;
    this.step = 2;
  }
}
