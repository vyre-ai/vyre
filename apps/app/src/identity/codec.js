// @ts-check
// Bytes in the identity's own forms (kernel/identity/chain.js): base64url without padding, sha256 as hex, random from the platform. WebCrypto only,
// so the same file runs in a browser, on a phone and in Node.

const enc = new TextEncoder();
export const utf8 = (/** @type {string} */ s) => enc.encode(s);
export { b64u, unb64, sha256hex } from "../../../../kernel/identity/chain.js";

/** @param {number} n @returns {Uint8Array} */
export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
