// @ts-check
// apk-sign: APK Signature Scheme v2 and v3 in plain JavaScript on node:crypto (ADR 0027, 4a).
//
// CI builds an unsigned release APK; the box signs it with its owner's own key, so the box image
// needs no JDK and no apksigner. The format is Android's (source.android.com, "APK Signature
// Scheme v2" and "v3"): an APK Signing Block goes between the ZIP entries and the central
// directory, holding one v2 block (id 0x7109871a) and one v3 block (id 0xf05368c0) over the same
// chunked SHA-256 content digest, and the end of central directory record's offset field is moved
// past it.
//
// What this refuses rather than fixes:
//  - an input that is not zip-aligned (a STORED entry whose data does not start on a 4-byte
//    boundary). Gradle's release APK is already aligned; run zipalign before this if not.
//  - an input that already has a signing block, is ZIP64, or has a malformed central directory.
//
// No v1 (JAR) signature is made, so the app must have minSdk 24 or higher: below Android 7.0 a
// phone would only read v1. The v3 signer covers SDK 28 and up, v2 covers 24 to 27.
//
// Only one signer and no key rotation. The owner's key lives in the box's vault; if it is lost,
// a new key cannot update the installed app, and re-pairing the phone reinstalls it (uninstall,
// then install the newly signed APK). That is the whole recovery story, on purpose.

import crypto from "node:crypto";
import { algorithmOf, certDer } from "./x509.js";

export const V2_ID = 0x7109871a;
export const V3_ID = 0xf05368c0;
/** v2's stripping protection: signed-data attribute naming the highest scheme also present (3). */
export const STRIPPING_PROTECTION_ID = 0xbeeff00d;
export const MAGIC = Buffer.from("APK Sig Block 42", "ascii");
export const ALG = { RSA_PKCS1_SHA256: 0x0103, ECDSA_SHA256: 0x0201 };
const CHUNK = 1024 * 1024;
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;
/** Where a v3 signer starts, and "no upper bound". */
export const V3_MIN_SDK = 28;
export const V3_MAX_SDK = 0x7fffffff;

// ---- little-endian length-prefixed structures ----

const u32 = (/** @type {number} */ n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (/** @type {number} */ n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
/** uint32 length, then the bytes. @param {Buffer} b */
const lp = b => Buffer.concat([u32(b.length), b]);
/** A length-prefixed sequence of length-prefixed items. @param {Buffer[]} items */
const lpSeq = items => lp(Buffer.concat(items.map(lp)));

// ---- the ZIP around it ----

/**
 * The three sections a v2/v3 digest covers, found in an unsigned APK.
 * @param {Buffer} apk
 */
export function zipSections(apk) {
  // The EOCD is 22 bytes plus a comment of up to 65535; the last one whose comment runs exactly to the end.
  let eocd = -1;
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 0xffff); i--) {
    if (apk.readUInt32LE(i) === EOCD_SIG && i + 22 + apk.readUInt16LE(i + 20) === apk.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP: no end of central directory record");
  const entries = apk.readUInt16LE(eocd + 10);
  const cdSize = apk.readUInt32LE(eocd + 12);
  const cdOffset = apk.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 APKs are not supported");
  if (cdOffset + cdSize !== eocd) throw new Error("the central directory does not end where the end record starts");
  if (cdOffset >= 16 + 8 && apk.subarray(cdOffset - 16, cdOffset).equals(MAGIC)) throw new Error("this APK is already signed (it has an APK Signing Block)");
  return { cdOffset, cdSize, eocd, entries };
}

/**
 * STORED entries whose data does not start on a 4-byte boundary. Empty means aligned as Android
 * needs (resources.arsc in particular must be mmap-able on Android 11+).
 * @param {Buffer} apk
 * @returns {string[]}
 */
export function misaligned(apk) {
  const { cdOffset, eocd, entries } = zipSections(apk);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || apk.readUInt32LE(p) !== CD_SIG) throw new Error("malformed central directory");
    const method = apk.readUInt16LE(p + 10);
    const n = apk.readUInt16LE(p + 28), x = apk.readUInt16LE(p + 30), c = apk.readUInt16LE(p + 32);
    const local = apk.readUInt32LE(p + 42);
    const name = apk.subarray(p + 46, p + 46 + n).toString("utf8");
    if (local + 30 > cdOffset || apk.readUInt32LE(local) !== LFH_SIG) throw new Error(`malformed local header for ${name}`);
    const data = local + 30 + apk.readUInt16LE(local + 26) + apk.readUInt16LE(local + 28);
    if (method === 0 && data % 4 !== 0) out.push(name);
    p += 46 + n + x + c;
  }
  return out;
}

/**
 * The chunked SHA-256 content digest (v2/v3 "CHUNKED_SHA256"): each section in 1 MiB chunks,
 * each chunk hashed as 0xa5 | uint32 length | bytes, then 0x5a | uint32 count | chunk digests.
 * @param {Buffer[]} sections
 */
export function contentDigest(sections) {
  const digests = [];
  for (const s of sections) {
    for (let off = 0; off < s.length; off += CHUNK) {
      const chunk = s.subarray(off, Math.min(off + CHUNK, s.length));
      digests.push(crypto.createHash("sha256").update(Buffer.from([0xa5])).update(u32(chunk.length)).update(chunk).digest());
    }
  }
  return crypto.createHash("sha256").update(Buffer.from([0x5a])).update(u32(digests.length)).update(Buffer.concat(digests)).digest();
}

/**
 * The digest a verifier computes over a signed APK: entries, central directory, and the EOCD with
 * its CD offset pointing at the signing block (which is where the unsigned CD started).
 * @param {Buffer} apk @param {{ entriesEnd: number, cdOffset: number, eocd: number }} at
 */
export function apkDigest(apk, { entriesEnd, cdOffset, eocd }) {
  const end = Buffer.from(apk.subarray(eocd));
  end.writeUInt32LE(entriesEnd, 16);
  return contentDigest([apk.subarray(0, entriesEnd), apk.subarray(cdOffset, eocd), end]);
}

// ---- keys ----

/**
 * The key, its public half as SubjectPublicKeyInfo DER, the certificate DER, and the algorithm id.
 * The certificate's public key must be the signing key's; a mismatch is refused here rather than
 * by a phone.
 * @param {{ key: string | Buffer | crypto.KeyObject, cert: string | Buffer }} signer
 */
export function signerOf({ key, cert }) {
  const priv = key instanceof crypto.KeyObject ? key : crypto.createPrivateKey(key);
  const kind = algorithmOf(priv).kind;
  const spki = /** @type {Buffer} */ (crypto.createPublicKey(priv).export({ type: "spki", format: "der" }));
  const der = certDer(cert);
  const certKey = /** @type {Buffer} */ (new crypto.X509Certificate(der).publicKey.export({ type: "spki", format: "der" }));
  if (!certKey.equals(spki)) throw new Error("the certificate is not for this key");
  return { priv, spki, der, alg: kind === "ec" ? ALG.ECDSA_SHA256 : ALG.RSA_PKCS1_SHA256 };
}

// ---- signing ----

/** One signer's block for v2 or v3. */
function signerBlock(/** @type {ReturnType<typeof signerOf>} */ s, /** @type {Buffer} */ digest, /** @type {2|3} */ v) {
  const digests = lpSeq([Buffer.concat([u32(s.alg), lp(digest)])]);
  const certs = lpSeq([s.der]);
  // v2 carries stripping protection: a v2-only verifier that sees it knows a v3 block was here.
  const attrs = v === 2 ? lpSeq([Buffer.concat([u32(STRIPPING_PROTECTION_ID), u32(3)])]) : lpSeq([]);
  const signed = v === 2 ? Buffer.concat([digests, certs, attrs])
    : Buffer.concat([digests, certs, u32(V3_MIN_SDK), u32(V3_MAX_SDK), attrs]);
  // ECDSA as DER (what Java's Signature produces), RSA as PKCS#1 v1.5: node's defaults for these keys.
  const sig = crypto.sign("sha256", signed, s.priv);
  const signatures = lpSeq([Buffer.concat([u32(s.alg), lp(sig)])]);
  const parts = v === 2 ? [lp(signed), signatures, lp(s.spki)] : [lp(signed), u32(V3_MIN_SDK), u32(V3_MAX_SDK), signatures, lp(s.spki)];
  return lpSeq([Buffer.concat(parts)]);
}

/** The APK Signing Block around some id-value pairs. @param {[number, Buffer][]} pairs */
function signingBlock(pairs) {
  const body = Buffer.concat(pairs.map(([id, v]) => Buffer.concat([u64(4 + v.length), u32(id), v])));
  const size = body.length + 8 + 16; // pairs, the trailing size, the magic
  return Buffer.concat([u64(size), body, u64(size), MAGIC]);
}

/**
 * Sign an unsigned, zip-aligned APK with v2 and v3. Returns the signed APK.
 * @param {Buffer} apk the unsigned APK
 * @param {{ key: string | Buffer | crypto.KeyObject, cert: string | Buffer }} signer
 *   key: a PKCS#8 (or any node-readable) PEM or KeyObject, EC P-256 or RSA; cert: its PEM or DER
 */
export function sign(apk, signer) {
  const s = signerOf(signer);
  const { cdOffset, eocd } = zipSections(apk);
  const bad = misaligned(apk);
  if (bad.length) throw new Error(`the APK is not zip-aligned (run zipalign -p 4 first): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}`);
  const digest = apkDigest(apk, { entriesEnd: cdOffset, cdOffset, eocd });
  const block = signingBlock([[V2_ID, signerBlock(s, digest, 2)], [V3_ID, signerBlock(s, digest, 3)]]);
  const end = Buffer.from(apk.subarray(eocd));
  end.writeUInt32LE(cdOffset + block.length, 16);
  return Buffer.concat([apk.subarray(0, cdOffset), block, apk.subarray(cdOffset, eocd), end]);
}

/** SHA-256 of a certificate's DER, lowercase hex: what Android and apksigner print as the signer digest. @param {string | Buffer} cert */
export const certSha256 = cert => crypto.createHash("sha256").update(certDer(cert)).digest("hex");
