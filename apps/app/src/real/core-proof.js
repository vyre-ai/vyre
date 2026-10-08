// @ts-check
// A Mac server's presence keys belong to vyre-core, which takes a key after the first only with a presence proof from a key it already has, over the exact enrolment input
// (core/vyre-core/server.js, ADR 0040). While this app is adding its server it holds one such key: the setup key it made for the install line, which core took as the server's first key.
// So at the pairing it signs the enrolment of its own presence key with that setup key, and puts the header in the hello (`core_proof`, with the `core_name` it signed). The server's
// relay hands it to core untouched. Nothing here is trusted by anyone but core, which checks the signature, the key and the input itself.

import { b64url, inputHash, presenceMessage, sha256 } from "../auth/person.ts";

/** ECDSA P1363 (r || s, 64 bytes, what WebCrypto signs) as the DER core's device method verifies. @param {Uint8Array} sig */
export function p1363ToDer(sig) {
  if (sig.length !== 64) throw new Error("not a P-256 signature");
  /** @param {Uint8Array} n */
  const int = (n) => {
    let i = 0;
    while (i < n.length - 1 && n[i] === 0) i++;
    let v = n.subarray(i);
    if (v[0] & 0x80) { const w = new Uint8Array(v.length + 1); w.set(v, 1); v = w; }
    return Uint8Array.from([0x02, v.length, ...v]);
  };
  const r = int(sig.subarray(0, 32)), s = int(sig.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

/** The id core gives a key it enrols: the first 22 characters of the base64url SHA-256 of its SPKI (core/presence fingerprint). @param {Uint8Array} spki */
export const presenceKeyId = (spki) => b64url(sha256(spki)).slice(0, 22);

/**
 * The presence header that enrols `public_key` (a device key, alg -7) under `name`, signed by the setup key.
 * @param {{ pageKey: { privateKey: CryptoKey, spki: Uint8Array }, name: string, public_key: string, kind?: "device" | "capsule", now?: () => number, nonce?: string }} o
 */
export async function coreEnrolProof(o) {
  const body = { kind: o.kind || "device", name: o.name, public_key: o.public_key, alg: -7 };
  const ts = String((o.now || Date.now)());
  const nonce = o.nonce || b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  const message = new TextEncoder().encode(presenceMessage("presence.enroll", await inputHash(body), ts, nonce));
  const raw = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.pageKey.privateKey, message));
  return `device key=${presenceKeyId(o.pageKey.spki)} ts=${ts} nonce=${nonce} sig=${b64url(p1363ToDer(raw))}`;
}

/**
 * The presence key this device offers in its pairing hello, with the proof a Mac server's core needs. With no setup key (a pairing that did not start from an install line) or no Secure Enclave key (a phone's, a browser's key is software to a release core, which refuses it
 * for this act), it is returned as it was. With `enclave` (this Mac app's Capsule key, SPKI base64url (shell.presenceKey)) the key offered IS that key, as the server's Capsule key: core takes it in the setup key's place, on the setup
 * key's signature over its enrolment, and its Touch ID proofs are the hardware kind a presence act on a release server needs.
 * @param {any} presenceKey @param {{ pageKey?: any, name: string, enclave?: string | null }} o
 */
export async function withCoreProof(presenceKey, o) {
  if (!o.pageKey || !o.enclave) return presenceKey;
  const name = String(o.name || "a device").slice(0, 80);
  return { public_key: o.enclave, alg: -7, storage: "hardware", kind: "capsule", core_name: name, core_proof: await coreEnrolProof({ pageKey: o.pageKey, name, public_key: o.enclave, kind: "capsule" }) };
}
