// @ts-check
// keys: OpenSSH private keys in and out of node's KeyObjects, and SSH signatures.
//
// Private keys are stored in the vault as the text `ssh-keygen` writes (openssh-key-v1), so a
// person can move one in or out with tools they already know. Node reads none of that format,
// so this parses it by hand into a JWK and lets node:crypto build the KeyObject. Three kinds:
// ssh-ed25519, ssh-rsa (signing only with rsa-sha2-256 or -512; SHA-1 is refused) and
// ecdsa-sha2-nistp256. A key encrypted with a passphrase is refused for now with a message that
// says how to import it; decrypting bcrypt-pbkdf keys is later work.

import crypto from "node:crypto";
import { Reader, str, u32, mpint, pad } from "./wire.js";

const MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
const ARMOR = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;
export const TYPES = ["ed25519", "rsa", "ecdsa"];
const WIRE = { ed25519: "ssh-ed25519", rsa: "ssh-rsa", ecdsa: "ecdsa-sha2-nistp256" };
const SHORT = { "ssh-ed25519": "ed25519", "ssh-rsa": "rsa", "ecdsa-sha2-nistp256": "ecdsa" };

const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url");
const big = b => (b.length ? BigInt("0x" + Buffer.from(b).toString("hex")) : 0n);
const bytes = n => { let h = n.toString(16); if (h.length % 2) h = "0" + h; return Buffer.from(h, "hex"); };

/** `SHA256:<base64, unpadded>` of a public key blob, as `ssh-keygen -l` prints it. */
export function fingerprint(blob) {
  return "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** The authorized_keys line for a public key blob. */
export function publicLine(blob, comment = "") {
  const r = new Reader(blob);
  return `${r.text()} ${Buffer.from(blob).toString("base64")}${comment ? " " + comment : ""}`;
}

/**
 * A public key blob as a node KeyObject, for verifying a host's session-bind signature.
 * @param {Buffer} blob @returns {{ type: string, key: crypto.KeyObject }}
 */
export function publicFromBlob(blob) {
  const r = new Reader(blob);
  const wire = r.text();
  if (wire === "ssh-ed25519") return { type: "ed25519", key: crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(r.string()) }, format: "jwk" }) };
  if (wire === "ssh-rsa") {
    const e = r.mpint(), n = r.mpint();
    return { type: "rsa", key: crypto.createPublicKey({ key: { kty: "RSA", n: b64u(n), e: b64u(e) }, format: "jwk" }) };
  }
  if (wire === "ecdsa-sha2-nistp256") {
    if (r.text() !== "nistp256") throw new Error("unsupported ecdsa curve");
    const q = r.string();
    if (q.length !== 65 || q[0] !== 4) throw new Error("bad ecdsa point");
    return { type: "ecdsa", key: crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(q.subarray(1, 33)), y: b64u(q.subarray(33)) }, format: "jwk" }) };
  }
  throw new Error(`unsupported ssh key type ${wire}`);
}

/**
 * @typedef {{ type: "ed25519"|"rsa"|"ecdsa", comment: string, key: crypto.KeyObject, blob: Buffer,
 *   fingerprint: string, public: string, bits: number }} SshKey
 */

/**
 * Parse an unencrypted openssh-key-v1 private key.
 * @param {string} text @returns {SshKey}
 */
export function parsePrivate(text) {
  const m = ARMOR.exec(String(text));
  if (!m) {
    if (/BEGIN (RSA|EC|DSA) PRIVATE KEY|BEGIN PRIVATE KEY/.test(String(text))) {
      throw new Error("this is a PEM key, not the OpenSSH format · convert a copy with ssh-keygen -p -f <copy> (it rewrites the file in the OpenSSH format)");
    }
    throw new Error("not an OpenSSH private key (expected -----BEGIN OPENSSH PRIVATE KEY-----)");
  }
  const raw = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an openssh-key-v1 key");
  const r = new Reader(raw.subarray(MAGIC.length));
  const cipher = r.text(), kdf = r.text();
  r.string(); // kdf options
  if (cipher !== "none" || kdf !== "none") {
    throw new Error("this key is encrypted with a passphrase, which the vault cannot import yet · " +
      "make an unencrypted copy with ssh-keygen -p -N \"\" -f <copy>, add the copy, then delete it");
  }
  if (r.uint32() !== 1) throw new Error("a key file with more than one key is not supported");
  const blob = Buffer.from(r.string());
  const p = new Reader(r.string());
  if (p.uint32() !== p.uint32()) throw new Error("the key's check bytes do not match (corrupt, or wrongly decrypted)");
  const wire = p.text();
  const type = SHORT[wire];
  if (!type) throw new Error(`ssh key type ${wire} is not supported (ed25519, rsa and ecdsa-sha2-nistp256 are)`);
  let jwk, bits;
  if (type === "ed25519") {
    const pub = p.string(), priv = p.string();
    if (pub.length !== 32 || priv.length !== 64) throw new Error("bad ed25519 key");
    jwk = { kty: "OKP", crv: "Ed25519", x: b64u(pub), d: b64u(priv.subarray(0, 32)) };
    bits = 256;
  } else if (type === "rsa") {
    const n = p.mpint(), e = p.mpint(), d = p.mpint(), iqmp = p.mpint(), P = p.mpint(), Q = p.mpint();
    const D = big(d);
    jwk = { kty: "RSA", n: b64u(n), e: b64u(e), d: b64u(d), p: b64u(P), q: b64u(Q),
      dp: b64u(bytes(D % (big(P) - 1n))), dq: b64u(bytes(D % (big(Q) - 1n))), qi: b64u(iqmp) };
    bits = n.length * 8;
  } else {
    if (p.text() !== "nistp256") throw new Error("unsupported ecdsa curve");
    const q = p.string(), d = p.mpint();
    if (q.length !== 65 || q[0] !== 4) throw new Error("bad ecdsa point");
    jwk = { kty: "EC", crv: "P-256", x: b64u(q.subarray(1, 33)), y: b64u(q.subarray(33)), d: b64u(pad(d, 32)) };
    bits = 256;
  }
  const comment = p.text();
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const out = /** @type {SshKey} */ ({ type, comment, key, blob, fingerprint: fingerprint(blob), public: publicLine(blob, comment), bits });
  // The public half in the file must be the public half of this private key.
  if (!blobFor(type, crypto.createPublicKey(key)).equals(blob)) throw new Error("the key's public half does not match its private half");
  return out;
}

/** The SSH public blob for a node public key. */
function blobFor(type, pub) {
  const j = /** @type {any} */ (pub.export({ format: "jwk" }));
  if (type === "ed25519") return Buffer.concat([str("ssh-ed25519"), str(unb64u(j.x))]);
  if (type === "rsa") return Buffer.concat([str("ssh-rsa"), mpint(unb64u(j.e)), mpint(unb64u(j.n))]);
  return Buffer.concat([str("ecdsa-sha2-nistp256"), str("nistp256"), str(Buffer.concat([Buffer.from([4]), pad(unb64u(j.x), 32), pad(unb64u(j.y), 32)]))]);
}

/**
 * Write a node private key as an unencrypted openssh-key-v1 file, the way ssh-keygen does.
 * @param {"ed25519"|"rsa"|"ecdsa"} type @param {crypto.KeyObject} key @param {string} [comment]
 */
export function serializePrivate(type, key, comment = "") {
  const j = /** @type {any} */ (key.export({ format: "jwk" }));
  const blob = blobFor(type, crypto.createPublicKey(key));
  let body;
  if (type === "ed25519") {
    const x = unb64u(j.x), d = unb64u(j.d);
    body = Buffer.concat([str(WIRE.ed25519), str(x), str(Buffer.concat([d, x]))]);
  } else if (type === "rsa") {
    body = Buffer.concat([str(WIRE.rsa), mpint(unb64u(j.n)), mpint(unb64u(j.e)), mpint(unb64u(j.d)), mpint(unb64u(j.qi)), mpint(unb64u(j.p)), mpint(unb64u(j.q))]);
  } else {
    const q = Buffer.concat([Buffer.from([4]), pad(unb64u(j.x), 32), pad(unb64u(j.y), 32)]);
    body = Buffer.concat([str(WIRE.ecdsa), str("nistp256"), str(q), mpint(unb64u(j.d))]);
  }
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, body, str(comment)]);
  const padLen = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))]);
  const raw = Buffer.concat([MAGIC, str("none"), str("none"), str(""), u32(1), str(blob), str(priv)]);
  const lines = raw.toString("base64").match(/.{1,70}/g) || [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * A new key, as openssh-key-v1 text. RSA is 3072 bits, as ssh-keygen's default.
 * @param {string} type @param {string} [comment]
 */
export function generateKey(type = "ed25519", comment = "") {
  if (!TYPES.includes(type)) throw new Error(`type is one of ${TYPES.join(", ")}`);
  const pair = type === "ed25519" ? crypto.generateKeyPairSync("ed25519")
    : type === "rsa" ? crypto.generateKeyPairSync("rsa", { modulusLength: 3072 })
      : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return serializePrivate(/** @type {any} */ (type), pair.privateKey, comment);
}

export const SSH_AGENT_RSA_SHA2_256 = 2;
export const SSH_AGENT_RSA_SHA2_512 = 4;

/**
 * Sign `data` for the agent protocol, returning the SSH signature blob. RSA without a SHA-2
 * flag asks for ssh-rsa (SHA-1), which is refused.
 * @param {SshKey} k @param {Buffer} data @param {number} flags
 */
export function sign(k, data, flags = 0) {
  if (k.type === "ed25519") return Buffer.concat([str("ssh-ed25519"), str(crypto.sign(null, data, k.key))]);
  if (k.type === "rsa") {
    const alg = flags & SSH_AGENT_RSA_SHA2_512 ? "rsa-sha2-512" : flags & SSH_AGENT_RSA_SHA2_256 ? "rsa-sha2-256" : null;
    if (!alg) throw Object.assign(new Error("ssh-rsa signatures use SHA-1, which the vault refuses"), { code: "sha1" });
    return Buffer.concat([str(alg), str(crypto.sign(alg === "rsa-sha2-512" ? "sha512" : "sha256", data, k.key))]);
  }
  const rs = crypto.sign("sha256", data, { key: k.key, dsaEncoding: "ieee-p1363" });
  return Buffer.concat([str("ecdsa-sha2-nistp256"), str(Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]))]);
}

/**
 * Check an SSH signature blob made by the key in `blob` over `data`. Used for a host key's
 * signature in session-bind, and by the tests. SHA-1 RSA is not accepted here either.
 */
export function verify(blob, data, sigBlob) {
  const { type, key } = publicFromBlob(blob);
  const r = new Reader(sigBlob);
  const alg = r.text(), sig = r.string();
  if (type === "ed25519" && alg === "ssh-ed25519") return crypto.verify(null, data, key, sig);
  if (type === "rsa" && (alg === "rsa-sha2-256" || alg === "rsa-sha2-512")) return crypto.verify(alg === "rsa-sha2-512" ? "sha512" : "sha256", data, key, sig);
  if (type === "ecdsa" && alg === "ecdsa-sha2-nistp256") {
    const s = new Reader(sig);
    const p1363 = Buffer.concat([pad(s.mpint(), 32), pad(s.mpint(), 32)]);
    return crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, p1363);
  }
  return false;
}
