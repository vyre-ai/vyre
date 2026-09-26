// @ts-check
// csr — a PKCS#10 certificate signing request, built by hand.
//
// Node can make keys and sign but cannot make a CSR, and Vyre takes no dependencies. A CSR for
// ACME needs very little: a subject CN, the public key, one extension request carrying the
// subject alternative names, and an ECDSA signature. So this is a minimal DER encoder for
// exactly those shapes and nothing more.

import crypto from "node:crypto";

/** DER length octets: short form below 128, long form above. */
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV. */
function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const utf8 = s => tlv(0x0c, Buffer.from(s, "utf8"));
const octets = b => tlv(0x04, b);
const bits = b => tlv(0x03, Buffer.concat([Buffer.from([0]), b])); // no unused bits
const int0 = () => tlv(0x02, Buffer.from([0]));

/** An OBJECT IDENTIFIER from dotted form. */
function oid(dotted) {
  const arcs = dotted.split(".").map(Number);
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const b = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) b.unshift(0x80 | (v & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

const OID = {
  commonName: "2.5.4.3",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
};

/**
 * A DER CSR for the given DNS names, signed by an EC P-256 key. The first name is the CN; all
 * of them go in the SAN, which is what certificate authorities actually read.
 * @param {string[]} names
 * @param {crypto.KeyObject} key private key
 * @returns {Buffer}
 */
export function csr(names, key) {
  if (!Array.isArray(names) || names.length === 0) throw new Error("csr needs at least one name");
  for (const n of names) if (typeof n !== "string" || !/^[A-Za-z0-9*_.-]+$/.test(n)) throw new Error(`"${n}" is not a DNS name`);
  if (key.asymmetricKeyType !== "ec") throw new Error("csr needs an EC key");
  // A CN longer than 64 characters is not allowed by X.520; leave the subject empty then and
  // rely on the SAN, as ACME servers expect.
  const subject = names[0].length <= 64 ? seq(set(seq(oid(OID.commonName), utf8(names[0])))) : seq();
  const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  const san = seq(...names.map(n => tlv(0x82, Buffer.from(n, "ascii")))); // [2] dNSName
  const extensions = seq(seq(oid(OID.subjectAltName), octets(san)));
  const attributes = tlv(0xa0, seq(oid(OID.extensionRequest), set(extensions))); // [0] IMPLICIT SET OF
  const info = seq(int0(), subject, spki, attributes);
  const signature = crypto.sign("sha256", info, key); // DER ECDSA-Sig-Value, which X.509 wants
  return seq(info, seq(oid(OID.ecdsaWithSHA256)), bits(signature));
}
