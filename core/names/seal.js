// @ts-check
// seal — passphrase encryption for a whole box backup (PLAN.md R8, plans/launch.md's Review
// response BLOCKER 3): "export leaks a plaintext-equivalent credential bundle" is fixed by never
// writing an unencrypted backup file at all.
//
// Same algorithm and cost as core/vault/backup.js's own passphrase seal (scrypt N=2^17 r=8 p=1,
// AES-256-GCM): a box backup is sealed the same way a vault backup already is, just over raw
// bytes (a tar.gz) instead of a JSON payload. Kept as its own small module, not an import of
// vault's file, so this stays launch's own code to change; if vault later wants one shared
// primitive instead of two copies of the same 20 lines, that is a small follow-up, not a
// redesign (flagged in CHAT.md).

import crypto from "node:crypto";

export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const MAGIC = "vyre-box-backup:v1:";
const AAD = "vyre:box-backup:v1";

export function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.normalize("NFKC").length < MIN_PASSPHRASE) {
    throw new Error(`a backup passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
}

/** scrypt with room for its memory; a cost outside sane bounds is refused before it runs. */
function derive(passphrase, salt, { N, r, p }) {
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) throw new Error("this backup names a scrypt cost that is not allowed");
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) throw new Error("this backup names a scrypt cost that is not allowed");
  return crypto.scryptSync(String(passphrase).normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 });
}

/**
 * Seal raw bytes under a passphrase. @param {Buffer} bytes @param {string} passphrase
 * @param {{ params?: { N: number, r: number, p: number } }} [opts] params is for tests only.
 * @returns {Buffer} MAGIC + one JSON line describing the seal, newline, then the ciphertext.
 */
export function seal(bytes, passphrase, { params = SCRYPT } = {}) {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", derive(passphrase, salt, params), iv);
  c.setAAD(Buffer.from(AAD));
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const head = { v: 1, kdf: "scrypt", N: params.N, r: params.r, p: params.p, at: Date.now(),
    salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), bytes: bytes.length };
  return Buffer.concat([Buffer.from(MAGIC), Buffer.from(JSON.stringify(head)), Buffer.from("\n"), ct]);
}

/** What a sealed backup says about itself, without the passphrase: never a secret to read. */
export function inspect(file) {
  const buf = Buffer.isBuffer(file) ? file : null;
  if (!buf || !buf.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new Error("not a sealed vyre backup");
  const nl = buf.indexOf(0x0a, MAGIC.length);
  if (nl === -1) throw new Error("not a sealed vyre backup");
  let head;
  try { head = JSON.parse(buf.subarray(MAGIC.length, nl).toString("utf8")); } catch { throw new Error("not a sealed vyre backup"); }
  if (!head || head.v !== 1 || head.kdf !== "scrypt" || !head.salt || !head.iv || !head.tag) throw new Error("not a sealed vyre backup");
  return { header: head, bodyStart: nl + 1 };
}

/**
 * Open a sealed backup. @param {Buffer} sealed @param {string} passphrase @returns {Buffer} the
 * original bytes (the plain tar.gz).
 */
export function open(sealed, passphrase) {
  const { header, bodyStart } = inspect(sealed);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", derive(passphrase, Buffer.from(header.salt, "base64"), header), Buffer.from(header.iv, "base64"));
    d.setAAD(Buffer.from(AAD));
    d.setAuthTag(Buffer.from(header.tag, "base64"));
    const out = Buffer.concat([d.update(sealed.subarray(bodyStart)), d.final()]);
    if (header.bytes != null && out.length !== header.bytes) throw new Error("size mismatch");
    return out;
  } catch { throw new Error("that passphrase does not open this backup"); }
}

export const isSealed = buf => Buffer.isBuffer(buf) && buf.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC));
