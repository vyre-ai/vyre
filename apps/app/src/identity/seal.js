// @ts-check
// The sealed record a name carries (lib/identity/directory.js sealRecord and openRecord), on WebCrypto: AES-256-GCM, the key HKDF-SHA256 of the lower-cased
// name (salt SEAL_TAG, info "record"), the name as associated data, output base64url of iv, ciphertext and tag. Byte-identical to the Node version; a test opens
// each one's output with the other.

import { b64u, unb64 } from "../../../../kernel/identity/chain.js";

export const SEAL_TAG = "vyre-id-seal-v1";
export const SEALED_MAX = 2048;
const enc = new TextEncoder();

/** @param {string} name */
async function sealKey(name) {
  const base = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (enc.encode(String(name).toLowerCase())), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(SEAL_TAG), info: enc.encode("record") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** @param {string} name @param {any} payload @param {(n: number) => Uint8Array} [random] */
export async function sealRecord(name, payload, random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (iv), additionalData: /** @type {BufferSource} */ (enc.encode(name)), tagLength: 128 }, await sealKey(name), /** @type {BufferSource} */ (enc.encode(JSON.stringify(payload)))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  const text = b64u(out);
  if (text.length > SEALED_MAX) throw Object.assign(new Error("the record is too large to seal"), { code: "too_large" });
  return text;
}

/** @param {string} name @param {string} sealed @returns {Promise<any|null>} */
export async function openRecord(name, sealed) {
  try {
    const raw = unb64(sealed);
    if (!raw || raw.length < 12 + 16) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (raw.subarray(0, 12)), additionalData: /** @type {BufferSource} */ (enc.encode(name)), tagLength: 128 }, await sealKey(name), /** @type {BufferSource} */ (raw.subarray(12)));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}
