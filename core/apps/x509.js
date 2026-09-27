// @ts-check
// x509: a minimal DER encoder for one kind of certificate: a self-signed X.509 v3 certificate
// for the box's Android release key (ADR 0027, 4a).
//
// Node can parse certificates (crypto.X509Certificate) but not build them, and the box image has
// no openssl CLI or JDK to lean on. An APK signature carries the signer's certificate, and Android
// uses it only as the identity an update must match: nobody chains it to a CA. So this builds just
// what that needs: subject and issuer CN=Vyre <box>, a random serial, a validity window (25 years
// by default), the key's own SubjectPublicKeyInfo, and basicConstraints cA=false, signed with
// ecdsa-with-SHA256 (an EC P-256 key) or sha256WithRSAEncryption (an RSA key).

import crypto from "node:crypto";

// ---- DER ----

/** A DER length: short form under 128, long form above. @param {number} n */
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
/** One TLV. @param {number} tag @param {Buffer} body */
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (/** @type {Buffer[]} */ ...parts) => tlv(0x30, Buffer.concat(parts));
const set = (/** @type {Buffer[]} */ ...parts) => tlv(0x31, Buffer.concat(parts));
/** A context-specific constructed tag, [n] EXPLICIT. @param {number} n @param {Buffer} body */
const explicit = (n, body) => tlv(0xa0 | n, body);
/** A non-negative INTEGER from big-endian bytes: leading zeros dropped, a zero added if the top bit is set. @param {Buffer} b */
function uint(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
/** An OBJECT IDENTIFIER from its dotted form. @param {string} dotted */
function oid(dotted) {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const bytes = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) bytes.unshift(0x80 | (v & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}
const NULL = Buffer.from([0x05, 0x00]);
const utf8 = (/** @type {string} */ s) => tlv(0x0c, Buffer.from(s, "utf8"));
/** A time as RFC 5280 wants it: UTCTime through 2049, GeneralizedTime from 2050. @param {Date} d */
function time(d) {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/[-:T]/g, "") + "Z"; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(digits.slice(2), "ascii")) : tlv(0x18, Buffer.from(digits, "ascii"));
}
const bitString = (/** @type {Buffer} */ b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

const OID = {
  cn: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  rsaSha256: "1.2.840.113549.1.1.11",
};

/**
 * The signature algorithm for a private key: ECDSA P-256 or RSA, both over SHA-256. Anything else
 * (another curve, Ed25519, DSA) is refused, since Android's v2/v3 IDs this signer uses cover these two.
 * @param {crypto.KeyObject} key
 */
export function algorithmOf(key) {
  const t = key.asymmetricKeyType;
  if (t === "ec") {
    const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
    if (curve !== "prime256v1") throw new Error(`an EC signing key must be P-256, not ${curve}`);
    return { kind: "ec", der: seq(oid(OID.ecdsaSha256)) };
  }
  if (t === "rsa") return { kind: "rsa", der: seq(oid(OID.rsaSha256), NULL) };
  throw new Error(`a ${t} key cannot sign an APK here; use EC P-256 or RSA`);
}

/**
 * A self-signed certificate for this key pair, as DER.
 * @param {{ privateKey: crypto.KeyObject | string, publicKey?: crypto.KeyObject | string, cn: string, years?: number, now?: Date }} opts
 * @returns {Buffer}
 */
export function selfSigned({ privateKey, publicKey, cn, years = 25, now = new Date() }) {
  const priv = typeof privateKey === "string" ? crypto.createPrivateKey(privateKey) : privateKey;
  const pub = publicKey ? (typeof publicKey === "string" ? crypto.createPublicKey(publicKey) : publicKey) : crypto.createPublicKey(priv);
  const alg = algorithmOf(priv);
  const name = seq(set(seq(oid(OID.cn), utf8(cn))));
  // Whole seconds; a minute back so a phone whose clock runs a little slow does not see it as not yet valid.
  const from = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const to = new Date(from);
  to.setUTCFullYear(to.getUTCFullYear() + years);
  // A positive 16-byte serial: random, top bit clear.
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  // basicConstraints, critical, cA left at its default (false): this certificate signs nothing else.
  const extensions = explicit(3, seq(seq(oid(OID.basicConstraints), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq()))));
  const tbs = seq(
    explicit(0, uint(Buffer.from([2]))), // v3
    uint(serial),
    alg.der,
    name,
    seq(time(from), time(to)),
    name,
    /** @type {Buffer} */ (pub.export({ type: "spki", format: "der" })),
    extensions,
  );
  const signature = crypto.sign("sha256", tbs, priv); // DER ECDSA-Sig-Value for EC, PKCS#1 v1.5 for RSA
  return seq(tbs, alg.der, bitString(signature));
}

/** DER to PEM. @param {Buffer} der */
export function toPem(der) {
  const b64 = der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** The first certificate in a PEM (or DER given as is) as DER. @param {string | Buffer} pem */
export function certDer(pem) {
  const text = Buffer.isBuffer(pem) ? pem.toString("latin1") : pem;
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text);
  if (m) return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  if (Buffer.isBuffer(pem) && pem[0] === 0x30) return pem;
  throw new Error("no certificate in that PEM");
}
