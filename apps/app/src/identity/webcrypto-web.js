// @ts-check
// Ed25519 verification on a browser whose WebCrypto has none (Chrome before 137, Safari before 17, Firefox before 129). The identity chain (kernel/identity/chain.js verifySig) verifies every signature with
// crypto.subtle; where the browser cannot, it used to answer false and the person saw "the first device signs its own genesis". This wraps subtle.importKey and subtle.verify for Ed25519 only: the browser's own
// is used first, and only when it says it does not support Ed25519 does the same @noble verify the phone uses (webcrypto-impl.js, strict RFC 8032) answer. Everything else is the browser's, untouched.
import { methods } from "./webcrypto-impl.js";

const FALLBACK = Symbol("vyre.ed25519-fallback-key");
const isEd = (/** @type {any} */ a) => String(typeof a === "string" ? a : a && a.name || "").toUpperCase() === "ED25519";
// A browser without Ed25519 refuses it as NotSupportedError, or (older Safari and others) as a SyntaxError or TypeError whose words say the algorithm is not known. A SyntaxError for any other reason is a real error of
// a browser that does have Ed25519, and is thrown on, never answered by the fallback.
const WORDS = /not supported|unrecognized|unsupported|not implemented/i;
const unsupported = (/** @type {any} */ e) => Boolean(e) && (e.name === "NotSupportedError" || ((e.name === "SyntaxError" || e.name === "TypeError") && WORDS.test(String(e.message))));

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
  // A WebKit that imports an Ed25519 key but refuses to verify with it (found in the Mac app's window): the public key's bytes are kept beside the browser's own key, so a refusal of the verify can be answered.
  const rawOf = new WeakMap();
  // A copy of the bytes, never a view of the caller's buffer: the caller may overwrite or reuse it after the import.
  const own = (/** @type {any} */ data) => (data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : data);
  // The browser's own Ed25519 is trusted only if it answers the known vector right (the good signature true, the tampered one false), checked once, before the first Ed25519 key is imported. A WebKit that answers
  // false for a good signature (found in the Mac app's window) or refuses outright is sent, whole, to the fallback. A browser that fails the check for some other reason (a thrown error that is not "not supported")
  // keeps its own answers, and the error reaches the caller as it always did.
  /** @type {Promise<boolean> | null} */ let nativeBroken = null;
  const brokenNative = () => nativeBroken || (nativeBroken = (async () => {
    try {
      const k = await nativeImport("raw", hex(VECTOR.pub), { name: "Ed25519" }, false, ["verify"]);
      const good = await nativeVerify({ name: "Ed25519" }, k, hex(VECTOR.sig), new Uint8Array(0));
      const bad = await nativeVerify({ name: "Ed25519" }, k, hex(VECTOR.sig), new Uint8Array([1]));
      return !(good === true && bad === false);
    } catch (e) { return unsupported(e); }
  })());
  subtle.importKey = async (/** @type {any} */ format, /** @type {any} */ data, /** @type {any} */ algo, /** @type {any[]} */ ...rest) => {
    if (!isEd(algo) || format !== "raw") return nativeImport(format, data, algo, ...rest);
    if (await brokenNative()) return { [FALLBACK]: await methods.importKey("raw", own(data), algo) };
    try {
      const key = await nativeImport(format, data, algo, ...rest);
      try { rawOf.set(key, own(data)); } catch { /* not keepable */ }
      return key;
    }
    catch (e) {
      if (!unsupported(e)) throw e;
      return { [FALLBACK]: await methods.importKey("raw", own(data), algo) };
    }
  };
  subtle.verify = async (/** @type {any} */ algo, /** @type {any} */ key, /** @type {any} */ sig, /** @type {any} */ msg) => {
    if (key && key[FALLBACK]) {
      // The key was made for Ed25519 only: any other algorithm named with it is refused the way a browser refuses a key used with the wrong algorithm.
      if (!isEd(algo)) throw Object.assign(new Error("The key is not usable with that algorithm"), { name: "InvalidAccessError" });
      return methods.verify(algo, key[FALLBACK], sig, msg);
    }
    try { return await nativeVerify(algo, key, sig, msg); }
    catch (e) {
      if (isEd(algo) && unsupported(e) && rawOf.has(key)) return methods.verify(algo, await methods.importKey("raw", rawOf.get(key), algo), sig, msg);
      throw e;
    }
  };
  Object.defineProperty(subtle, "__vyreEd25519", { value: true });
  return true;
}

/** Can this page verify an Ed25519 signature (the browser's own or the fallback)? Checked with a known vector and a tampered one: it must say yes to the first and no to the second. */
let why = "";
/** The name (never the text) of what stopped the last Ed25519 self-check, for the first-run trail. */
export const ed25519Why = () => why;
export async function ed25519Works(/** @type {any} */ g = globalThis) {
  why = "";
  try {
    const key = await g.crypto.subtle.importKey("raw", hex(VECTOR.pub), { name: "Ed25519" }, false, ["verify"]);
    const good = await g.crypto.subtle.verify({ name: "Ed25519" }, key, hex(VECTOR.sig), new Uint8Array(0));
    const bad = await g.crypto.subtle.verify({ name: "Ed25519" }, key, hex(VECTOR.sig), new Uint8Array([1]));
    if (!(good === true && bad === false)) why = `wrong answer ${good} ${bad}`;
    return good === true && bad === false;
  } catch (e) { why = `${String((/** @type {any} */ (e)) && (/** @type {any} */ (e)).name || "Error")} ${g && g.crypto && g.crypto.subtle ? "has subtle" : "no subtle"}`; return false; }
}

export const BROWSER_TOO_OLD = "This browser is too old for Vyre. Update it, or use the Vyre app.";
