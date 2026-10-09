// @ts-check
// The recovery code as a wrapping key: the IDENTITY's recovery code (the 26 base32 characters of core/spaces/recovery.js, with the optional recovery password), stretched (Argon2id, kernel/identity/stretch.js)
// and HKDF'd to a key of its own, so the identity's signing seed is never used as an encryption key. The identity home (core/memory/identity/home.js) and the Space bundle (lib/space-bundle.js) wrap their
// keys to it, so one code is the way back into both when every device is lost.
import { seal, open } from "./keywrap.js";
import { argon2id, STRETCH, STRETCH_SALT } from "../kernel/identity/stretch.js";
import { derive, utf8 } from "./databox.js";

const normalizeCode = (/** @type {unknown} */ code) => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");
export const codeLooksRight = (/** @type {unknown} */ code) => /^[a-z2-7]{26}$/.test(normalizeCode(code));
const codeSecret = (/** @type {string} */ code, /** @type {string} */ password) => {
  if (!codeLooksRight(code)) throw Object.assign(new Error("that is not a recovery code"), { code: "bad_code" });
  return derive(argon2id(utf8(`${normalizeCode(code)}\n${String(password ?? "").normalize("NFKC")}`), STRETCH_SALT, STRETCH), "vyre-identity-home-code-wrap-v1");
};
export const wrapWithCode = (/** @type {Uint8Array} */ key, /** @type {string} */ code, /** @type {string} */ aad, password = "") => { const b = seal(key, codeSecret(code, password), aad); return { v: 2, iv: b.iv, ct: b.ct, tag: b.tag }; };
export const unwrapWithCode = (/** @type {any} */ w, /** @type {string} */ code, /** @type {string} */ aad, password = "") => open({ v: 1, iv: w.iv, ct: w.ct, tag: w.tag }, codeSecret(code, password), aad);

