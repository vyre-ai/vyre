// @ts-check
// drop-seal: a dropped file is sealed on the sending device to the receiving device's own key, so the server that holds it until the receiver connects, and the relay it crosses, only ever see ciphertext.
// The receiving key is the device's key-agreement key (`agree`, a P-256 point on its entry of the person's identity list, lib/keywrap.js): the sender reads it from the identity list, never from the server.
// Each drop has a fresh 32-byte file key wrapped to that point (ECDH-ES, so no two drops share a key); the chunks are AES-256-GCM under a key derived from it with the drop's id as salt, and a chunk's place in
// the associated data, so a chunk cannot be moved, repeated, dropped or taken from another drop without the receiver noticing. Chunk 0 is the header (name, size, hash of the whole file), the rest are the file in order.
import crypto from "node:crypto";
import { newKey, wrapForDevice, jwkOfPoint, unb64 } from "../../lib/keywrap.js";

export const CHUNK = 512 * 1024;
const bytesB64 = (/** @type {Buffer} */ b) => b.toString("base64url");
const keyFor = (/** @type {Uint8Array} */ fileKey, /** @type {string} */ id) => Buffer.from(crypto.hkdfSync("sha256", fileKey, id, "vyre-drop-v2", 32));
const nonce = (/** @type {number} */ i) => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(i), 4); return n; };
const aad = (/** @type {string} */ id, /** @type {number} */ i, /** @type {number} */ total) => Buffer.from(`vyre-drop\n${id}\n${i}\n${total}`);
/** What the wrap of the file key is bound to: this drop and the receiving entry. */
const wrapAad = (/** @type {string} */ id, /** @type {string} */ eid) => `vyre-drop-wrap\n${id}\n${eid}`;

/**
 * The sender's half. `toPoint` is the receiving device's key-agreement point (65-byte uncompressed P-256, base64url) from the identity list and `toEid` its entry id. Returns the wrapped file key to hand the receiver and `seal(i, total, plain)`: the chunk's ciphertext (with its tag).
 * @param {string} id the drop's id @param {string} toPoint @param {string} toEid
 */
export function sender(id, toPoint, toEid) {
  const fileKey = newKey();
  const wrapped = wrapForDevice(fileKey, jwkOfPoint(unb64(toPoint)), wrapAad(id, toEid));
  const key = keyFor(fileKey, id);
  return {
    /** the wrapped file key, as one string for the receiver (the server holds it with the drop) */
    eph: bytesB64(Buffer.from(JSON.stringify(wrapped))),
    /** @param {number} i @param {number} total @param {Buffer} plain */
    seal(i, total, plain) {
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce(i)); c.setAAD(aad(id, i, total));
      return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    },
  };
}

/**
 * The receiver's half: `open(i, total, blob)` the chunk's plaintext, or throws `bad_chunk` when it is not exactly the chunk the sender sealed for this place in this drop. `unwrap(wrap, aad)` is this device's
 * key-agreement step in the identity module: the wrap and its associated data in, only the file key out (the private key and the shared secret never leave it) and `eid` is its own entry id.
 * @param {string} id @param {string} eph the wrapped file key @param {(wrap: any, aad: string) => Promise<Uint8Array>} unwrap @param {string} eid
 */
export async function receiver(id, eph, unwrap, eid) {
  /** @type {any} */ let w;
  try { w = JSON.parse(Buffer.from(String(eph), "base64url").toString("utf8")); } catch { throw Object.assign(new Error("this drop's key is damaged"), { code: "bad_chunk" }); }
  /** @type {Uint8Array} */ let fileKey;
  try { fileKey = await unwrap(w, wrapAad(id, eid)); } catch { throw Object.assign(new Error("this drop is not sealed to this computer's key"), { code: "bad_chunk" }); }
  const key = keyFor(fileKey, id);
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
