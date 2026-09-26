// @ts-check
// Web Push with node:crypto only: VAPID (RFC 8292) to say who is sending, and aes128gcm
// (RFC 8291 over RFC 8188) so only the browser that subscribed can read the payload. The push
// service (Google's, Mozilla's, Apple's) relays bytes it cannot open.

import crypto from "node:crypto";

const b64u = (/** @type {Buffer} */ b) => Buffer.from(b).toString("base64url");
const unb64u = (/** @type {string} */ s) => Buffer.from(String(s), "base64url");
const hmac = (/** @type {Buffer} */ key, /** @type {Buffer} */ data) => crypto.createHmac("sha256", key).update(data).digest();

/** A new VAPID keypair: the private key as PKCS#8 (base64url), the public key raw (65 bytes, base64url). */
export function vapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { private: b64u(privateKey.export({ format: "der", type: "pkcs8" })), public: b64u(rawPublic(publicKey)) };
}

/** An uncompressed P-256 point, 0x04 || x || y. @param {crypto.KeyObject} key */
function rawPublic(key) {
  const j = /** @type {any} */ (key.export({ format: "jwk" }));
  return Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]);
}

/**
 * The Authorization header for one push service (RFC 8292): an ES256 JWT for its origin, and
 * the public key the browser was given when it subscribed.
 * @param {{ endpoint: string, privateKey: string, publicKey: string, subject: string, now?: number }} o
 */
export function vapidAuth(o) {
  const aud = new URL(o.endpoint).origin;
  const exp = Math.floor((o.now ?? Date.now()) / 1000) + 12 * 3600;       // at most 24h; 12 leaves room for clock skew
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp, sub: o.subject })));
  const key = crypto.createPrivateKey({ key: unb64u(o.privateKey), format: "der", type: "pkcs8" });
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${o.publicKey}`;
}

/**
 * Encrypt a payload for one subscription (RFC 8291, a single aes128gcm record).
 * @param {{ p256dh: string, auth: string }} keys the subscription's keys, base64url
 * @param {Buffer} payload
 * @param {{ salt?: Buffer, ecdh?: crypto.ECDH }} [fixed] for tests only
 */
export function encrypt(keys, payload, fixed = {}) {
  const ua = unb64u(keys.p256dh);
  const secret = unb64u(keys.auth);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error("the subscription's p256dh is not a P-256 public key");
  if (secret.length !== 16) throw new Error("the subscription's auth secret is not 16 bytes");
  const ecdh = fixed.ecdh || crypto.createECDH("prime256v1");
  if (!fixed.ecdh) ecdh.generateKeys();
  const as = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  // IKM from the shared secret, bound to both public keys and the subscription's auth secret.
  const ikm = hmac(hmac(secret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua, as, Buffer.from([1])]));
  const salt = fixed.salt || crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const record = 4096;
  if (payload.length + 17 + 86 > record) throw new Error("the payload is too big for one record");
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(record, 16);
  head[20] = as.length;
  return Buffer.concat([head, as, body]);
}

/**
 * Send one push. Resolves to { ok, status, gone }: gone means the subscription is dead (404/410)
 * and must be dropped. Never throws for an HTTP answer; a network failure is { ok: false, status: 0 }.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} sub
 * @param {object} message
 * @param {{ privateKey: string, publicKey: string, subject: string, ttl?: number, urgency?: string, topic?: string, fetch?: typeof fetch }} o
 */
export async function send(sub, message, o) {
  const body = encrypt(sub.keys, Buffer.from(JSON.stringify(message)));
  const headers = {
    authorization: vapidAuth({ endpoint: sub.endpoint, privateKey: o.privateKey, publicKey: o.publicKey, subject: o.subject }),
    "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
    ttl: String(o.ttl ?? 86400), urgency: o.urgency || "high", ...(o.topic ? { topic: o.topic } : {}),
  };
  try {
    const r = await (o.fetch || fetch)(sub.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch { return { ok: false, status: 0, gone: false }; }
}
