// @ts-check
// drop-seal: a dropped file is sealed on the sending device to the receiving device's own key, so the server that holds it until the receiver connects, and the relay it crosses, only ever see ciphertext.
// Each drop uses a fresh ephemeral X25519 key (so no two drops share a key), HKDF-SHA256 with the drop's id as salt, and AES-256-GCM per chunk with the chunk's place in the associated data, so a chunk
// cannot be moved, repeated, dropped or taken from another drop without the receiver noticing. Chunk 0 is the header (name, size, hash of the whole file), the rest are the file in order.
import crypto from "node:crypto";

export const CHUNK = 512 * 1024;
const b64 = (/** @type {Buffer} */ b) => b.toString("base64url");

/** A device's drop key: made once, kept in a 0600 file by the caller. @returns {{ pub: string, priv: string }} */
export function newDropKey() {
  const k = crypto.generateKeyPairSync("x25519");
  return { pub: b64(k.publicKey.export({ type: "spki", format: "der" })), priv: b64(k.privateKey.export({ type: "pkcs8", format: "der" })) };
}
const pubOf = (/** @type {string} */ p) => crypto.createPublicKey({ key: Buffer.from(p, "base64url"), type: "spki", format: "der" });
const privOf = (/** @type {string} */ p) => crypto.createPrivateKey({ key: Buffer.from(p, "base64url"), type: "pkcs8", format: "der" });
const keyFor = (/** @type {Buffer} */ shared, /** @type {string} */ id) => Buffer.from(crypto.hkdfSync("sha256", shared, id, "vyre-drop-v1", 32));
const nonce = (/** @type {number} */ i) => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(i), 4); return n; };
const aad = (/** @type {string} */ id, /** @type {number} */ i, /** @type {number} */ total) => Buffer.from(`vyre-drop\n${id}\n${i}\n${total}`);

/**
 * The sender's half. `toPub` is the receiving device's drop key. Returns the ephemeral public key to hand the receiver and `seal(i, total, plain)`: the chunk's ciphertext (with its tag).
 * @param {string} id the drop's id @param {string} toPub
 */
export function sender(id, toPub) {
  const eph = crypto.generateKeyPairSync("x25519");
  const key = keyFor(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubOf(toPub) }), id);
  return {
    eph: b64(eph.publicKey.export({ type: "spki", format: "der" })),
    /** @param {number} i @param {number} total @param {Buffer} plain */
    seal(i, total, plain) {
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce(i)); c.setAAD(aad(id, i, total));
      return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    },
  };
}

/**
 * The receiver's half: `open(i, total, blob)` the chunk's plaintext, or throws `bad_chunk` when it is not exactly the chunk the sender sealed for this place in this drop.
 * @param {string} id @param {string} eph the sender's ephemeral public key @param {string} priv this device's drop key
 */
export function receiver(id, eph, priv) {
  const key = keyFor(crypto.diffieHellman({ privateKey: privOf(priv), publicKey: pubOf(eph) }), id);
  return {
    /** @param {number} i @param {number} total @param {Buffer} blob */
    open(i, total, blob) {
      try {
        if (blob.length < 16) throw new Error("short");
        const d = crypto.createDecipheriv("aes-256-gcm", key, nonce(i)); d.setAAD(aad(id, i, total)); d.setAuthTag(blob.subarray(-16));
        return Buffer.concat([d.update(blob.subarray(0, -16)), d.final()]);
      } catch { throw Object.assign(new Error("a chunk of the file did not open: it is damaged or not from this drop"), { code: "bad_chunk" }); }
    },
  };
}
