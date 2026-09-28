// @ts-check
// nodecrypto: a Node-native crypto provider for relay/client, so a Node process (a CLI redeeming
// a one-time pairing code as a new device) can run without @noble (noble.js, the Expo app's own
// choice) or the browser's IndexedDB key store. Node's globalThis.crypto.subtle already runs
// X25519 fine (client.test.js uses webCrypto() directly in Node), but subtle.generateKey's keys
// are non-extractable by design, so they cannot survive a process restart the way a real device
// identity must, a CLI runs as a fresh process every time. This provider works in raw,
// extractable, persistable bytes instead, the same primitives core/relay/noise.js already uses
// for the box's own side, so a Node keyStore can simply write them to a file (see fileKeyStore
// below), matching core/relay/keys.js's own pattern.

import crypto from "node:crypto";

const DHLEN = 32;
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = raw => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(raw)]), format: "der", type: "pkcs8" });
const publicKey = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw)]), format: "der", type: "spki" });

/** @returns {import("./noise.js").CryptoProvider} */
export function nodeCrypto() {
  return {
    async generateKeyPair() {
      const priv = crypto.randomBytes(DHLEN);
      const pub = crypto.createPublicKey(privateKey(priv)).export({ format: "der", type: "spki" }).subarray(-DHLEN);
      return { privateKey: new Uint8Array(priv), publicKey: new Uint8Array(pub) };
    },
    async dh(priv, pub) {
      if (pub.length !== DHLEN) throw new Error("an X25519 public key is 32 bytes");
      let out;
      try { out = crypto.diffieHellman({ privateKey: privateKey(priv), publicKey: publicKey(pub) }); } catch { throw new Error("invalid peer key"); }
      if (crypto.timingSafeEqual(out, Buffer.alloc(DHLEN))) throw new Error("invalid peer key");
      return new Uint8Array(out);
    },
    async sha256(b) { return new Uint8Array(crypto.createHash("sha256").update(b).digest()); },
    async hmacSha256(key, b) { return new Uint8Array(crypto.createHmac("sha256", Buffer.from(key)).update(Buffer.from(b)).digest()); },
    async aesGcmEncrypt(key, nonce, ad, pt) {
      const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
      c.setAAD(Buffer.from(ad));
      const body = Buffer.concat([c.update(Buffer.from(pt)), c.final()]);
      return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
    },
    async aesGcmDecrypt(key, nonce, ad, ct) {
      const buf = Buffer.from(ct);
      if (buf.length < 16) throw new Error("decrypt failed");
      const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
      d.setAAD(Buffer.from(ad));
      d.setAuthTag(buf.subarray(buf.length - 16));
      try { return new Uint8Array(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()])); }
      catch { throw new Error("decrypt failed"); }
    },
    randomBytes: len => new Uint8Array(crypto.randomBytes(len)),
  };
}

/**
 * A device's static key, persisted as raw bytes in a JSON file (0600), the same shape
 * core/relay/keys.js uses for the box's own keys. Round-trips with nodeCrypto()'s KeyPair
 * ({ privateKey, publicKey }, both Uint8Array); every write replaces the file atomically.
 * @param {string} file
 * @returns {import("./webcrypto.js").KeyStore}
 */
export function fileKeyStore(file) {
  return {
    async get() {
      let raw;
      try { raw = JSON.parse((await import("node:fs")).readFileSync(file, "utf8")); }
      catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
      return { privateKey: Buffer.from(raw.privateKey, "base64url"), publicKey: Buffer.from(raw.publicKey, "base64url") };
    },
    async set(kp) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, privateKey: Buffer.from(kp.privateKey).toString("base64url"), publicKey: Buffer.from(kp.publicKey).toString("base64url") }) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
