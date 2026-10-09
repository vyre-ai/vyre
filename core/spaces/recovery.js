// @ts-check
// spaces: the recovery code (team/0.3/DESIGN-wink.md section 2). A code is 128 random bits written as 26 base32 characters in groups of four.
// With an optional recovery PASSWORD the person memorises, the paper alone is not enough: the key is Argon2id (kernel/identity/stretch.js, one file
// for every client and verifier) of both. Only the PUBLIC half is on the identity's list, so a short password adds only the cost of that function
// against an offline guesser who holds the paper: the setup copy recommends four or more words, and the minimum here is eight characters.
//
// The code is a way BACK IN, never a way to take over: on the chain it can only add a device, and that device is a newcomer for 24 hours.
// The honest limit stays: whoever holds the code, and the password if one is set, can read as the person until an older device removes them.

import crypto from "node:crypto";
import { keyId } from "../../lib/identity/directory.js";
import { argon2id, STRETCH, STRETCH_SALT } from "../../kernel/identity/stretch.js";
import { base32 } from "../../lib/bytes.js";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
export const PASSWORD_MIN = 8;

/** A fresh code: 128 bits as 26 characters in groups of four. @param {(n: number) => Buffer} [random] */
export function newCode(random = crypto.randomBytes) {
  const raw = random(16);
  return base32(raw).slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
}

/** What a person types back is forgiving about case, spaces and dashes. @param {unknown} code */
export const normalizeCode = code => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");
export const codeLooksRight = (/** @type {unknown} */ code) => /^[a-z2-7]{26}$/.test(normalizeCode(code));

/**
 * The Ed25519 key a code (and password) stands for. `params` is for tests only: the work factor is part of what makes a stolen paper slow to use.
 * @param {string} code @param {string} [password] @param {{ memoryKiB: number, passes: number }} [params]
 */
export function codeKey(code, password = "", params = STRETCH) {
  if (!codeLooksRight(code)) throw Object.assign(new Error("that is not a recovery code"), { code: "bad_code" });
  const seed = argon2id(Buffer.from(`${normalizeCode(code)}\n${String(password ?? "").normalize("NFKC")}`), STRETCH_SALT, params);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { eid: keyId(pub), publicKey: Buffer.from(pub).toString("base64url"), sign: (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey) };
}
