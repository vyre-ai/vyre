// @ts-check
// The recovery code on a device that has no Node (core/spaces/recovery.js, kernel/identity/stretch.js): 128 random bits as 26 base32 characters in groups of
// four, and the Ed25519 key it (and an optional password) stands for, from Argon2id with the one parameter set every client and verifier uses. @noble/hashes
// does the Argon2id; a test pins its answer to the Node file's, byte for byte, with the real parameters.

import { argon2idAsync } from "@noble/hashes/argon2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { eidOf, b64u } from "../../../../kernel/identity/chain.js";
import { base32 } from "../../../../lib/bytes.js";

export const PASSWORD_MIN = 8;
/** The work factor: kernel/identity/stretch.js STRETCH. Part of what makes a stolen paper slow to use. */
export const STRETCH = Object.freeze({ memoryKiB: 19456, passes: 2 });
export const STRETCH_SALT = "vyre-recovery-code-v1";

/** @param {(n: number) => Uint8Array} [random] */
export function newCode(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const raw = random(16);
  return base32(raw).slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
}
/** @param {unknown} code */
export const normalizeCode = code => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");
/** @param {unknown} code */
export const codeLooksRight = code => /^[a-z2-7]{26}$/.test(normalizeCode(code));

/**
 * The key a code (and password) stands for: its entry id and public half. The private half is never kept (only the person's paper and memory hold it).
 * @param {string} code @param {string} [password] @param {{ memoryKiB: number, passes: number }} [params]
 * @returns {Promise<{ eid: string, publicKey: string }>}
 */
export async function codeKey(code, password = "", params = STRETCH) {
  if (!codeLooksRight(code)) throw Object.assign(new Error("that is not a recovery code"), { code: "bad_code" });
  const secret = new TextEncoder().encode(`${normalizeCode(code)}\n${String(password ?? "").normalize("NFKC")}`);
  const seed = await argon2idAsync(secret, new TextEncoder().encode(STRETCH_SALT), { t: params.passes, m: params.memoryKiB, p: 1, dkLen: 32, asyncTick: 20 });
  const pub = ed25519.getPublicKey(seed);
  return { eid: await eidOf(pub), publicKey: b64u(pub) };
}

/**
 * The same key as codeKey, with its signer: for the one moment a recovery code is used (a new device is added to the list, signed by the code's key). The private half lives for this call.
 * @param {string} code @param {string} [password] @param {{ memoryKiB: number, passes: number }} [params]
 * @returns {Promise<{ eid: string, publicKey: string, sign: (m: Uint8Array) => Promise<Uint8Array> }>}
 */
export async function codeSigner(code, password = "", params = STRETCH) {
  if (!codeLooksRight(code)) throw Object.assign(new Error("that is not a recovery code"), { code: "bad_code" });
  const secret = new TextEncoder().encode(`${normalizeCode(code)}\n${String(password ?? "").normalize("NFKC")}`);
  const seed = await argon2idAsync(secret, new TextEncoder().encode(STRETCH_SALT), { t: params.passes, m: params.memoryKiB, p: 1, dkLen: 32, asyncTick: 20 });
  const pub = ed25519.getPublicKey(seed);
  return { eid: await eidOf(pub), publicKey: b64u(pub), sign: async m => ed25519.sign(m, seed) };
}
