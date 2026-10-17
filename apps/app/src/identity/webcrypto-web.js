// @ts-check
// Ed25519 verification on a browser whose WebCrypto has none (Chrome before 137, Safari before 17, Firefox before 129). The identity chain (kernel/identity/chain.js verifySig) verifies every signature with
// crypto.subtle; where the browser cannot, it used to answer false and the person saw "the first device signs its own genesis". This wraps subtle.importKey and subtle.verify for Ed25519 only: the browser's own
// is used first, and only when it says it does not support Ed25519 does the same @noble verify the phone uses (webcrypto-impl.js, strict RFC 8032) answer. Everything else is the browser's, untouched.
import { methods } from "./webcrypto-impl.js";

const FALLBACK = Symbol("vyre.ed25519-fallback-key");
const isEd = (/** @type {any} */ a) => String(typeof a === "string" ? a : a && a.name || "").toUpperCase() === "ED25519";
const unsupported = (/** @type {any} */ e) => Boolean(e) && (e.name === "NotSupportedError" || e.name === "SyntaxError" || /not supported|unrecognized|unsupported|not implemented/i.test(String(e.message)));

/** RFC 8032 section 7.1, test 1: a public key, the empty message and its signature. Known good. */
export const VECTOR = Object.freeze({
  pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
});
const hex = (/** @type {string} */ h) => Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));

/**
 * Put the Ed25519 fallback on `g.crypto.subtle`. Idempotent. Returns false when there is no subtle at all to wrap.
 * @param {any} g globalThis
 */
export function installEd25519Fallback(g) {
  const subtle = g && g.crypto && g.crypto.subtle;
  if (!subtle || subtle.__vyreEd25519) return Boolean(subtle);
  const nativeImport = subtle.importKey.bind(subtle), nativeVerify = subtle.verify.bind(subtle);
  subtle.importKey = async (/** @type {any} */ format, /** @type {any} */ data, /** @type {any} */ algo, /** @type {any[]} */ ...rest) => {
    if (!isEd(algo) || format !== "raw") return nativeImport(format, data, algo, ...rest);
    try { return await nativeImport(format, data, algo, ...rest); }
    catch (e) {
      if (!unsupported(e)) throw e;
      return { [FALLBACK]: await methods.importKey("raw", data, algo) };
    }
  };
  subtle.verify = async (/** @type {any} */ algo, /** @type {any} */ key, /** @type {any} */ sig, /** @type {any} */ msg) => {
    if (key && key[FALLBACK]) return methods.verify(algo, key[FALLBACK], sig, msg);
    return nativeVerify(algo, key, sig, msg);
  };
  Object.defineProperty(subtle, "__vyreEd25519", { value: true });
  return true;
}

/** Can this page verify an Ed25519 signature (the browser's own or the fallback)? Checked with a known vector and a tampered one: it must say yes to the first and no to the second. */
export async function ed25519Works(/** @type {any} */ g = globalThis) {
  try {
    const key = await g.crypto.subtle.importKey("raw", hex(VECTOR.pub), { name: "Ed25519" }, false, ["verify"]);
    const good = await g.crypto.subtle.verify({ name: "Ed25519" }, key, hex(VECTOR.sig), new Uint8Array(0));
    const bad = await g.crypto.subtle.verify({ name: "Ed25519" }, key, hex(VECTOR.sig), new Uint8Array([1]));
    return good === true && bad === false;
  } catch { return false; }
}

export const BROWSER_TOO_OLD = "This browser is too old for Vyre. Update it, or use the Vyre app.";
