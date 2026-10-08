// @ts-check
// A passkey as the identity's first device (0.2.9, gap A29: claim a name from a browser with a passkey). A browser with no box makes the identity with a WebAuthn credential instead of a WebCrypto key a script on the
// page could use: the genesis entry is `{ alg: "webauthn-es256", rp, kind: "device" }`, the credential signs the genesis and every later op with user presence AND verification (kernel/identity/chain.js
// verifyWebAuthn is the check), and a passkey is a full device: it may change who speaks for the identity, which a web-held key may not (KP-1). Nothing here needs a library: a small CBOR reader for the
// attestation, the browser's own navigator.credentials, and kernel/identity/chain.js for the encoding.
//
//   const key = await createPasskeyKey({ rp: "app.vyre.run" });              // asks the person (Touch ID, Face ID, Windows Hello, a security key)
//   claimIdentity({ ..., key })                                              // claim.js writes the passkey's entry and signs the genesis and the record with key.sign
//
// `webauthn` is the seam (a test passes a software authenticator): { create(options), get(options) } the way navigator.credentials has them.

import { b64u, eidOf, unb64 } from "../../../../kernel/identity/chain.js";

const enc = new TextEncoder();
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const sha256 = async (/** @type {Uint8Array} */ b) => new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (b)));
const bytes = (/** @type {any} */ x) => (x instanceof Uint8Array ? x : new Uint8Array(/** @type {ArrayBuffer} */ (x)));

/**
 * A reader for the small part of CBOR a WebAuthn attestation uses: unsigned and negative integers, byte and text strings, arrays and maps (a Map, so integer keys survive), true, false, null.
 * @param {Uint8Array} b @returns {any}
 */
export function cbor(b) {
  let i = 0;
  const u = (/** @type {number} */ n) => {
    if (n < 24) return n;
    if (n === 24) return b[i++];
    if (n === 25) { const v = (b[i] << 8) | b[i + 1]; i += 2; return v; }
    if (n === 26) { const v = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; i += 4; return v; }
    throw refuse("That passkey answer is not in a shape Vyre reads.", "bad_attestation");
  };
  /** @param {number} depth @returns {any} */
  const item = (depth) => {
    if (depth > 8 || i >= b.length) throw refuse("That passkey answer is not in a shape Vyre reads.", "bad_attestation");
    const head = b[i++], major = head >> 5, n = u(head & 31);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) { if (i + n > b.length) throw refuse("That passkey answer is cut short.", "bad_attestation"); const s = b.slice(i, i + n); i += n; return major === 2 ? s : new TextDecoder().decode(s); }
    if (major === 4) { const a = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
    if (major === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); } return m; }
    if (major === 7) return n === 20 ? false : n === 21 ? true : null;
    throw refuse("That passkey answer is not in a shape Vyre reads.", "bad_attestation");
  };
  return item(0);
}

/** The credential id and the raw 65-byte public key out of an attestation object, after the checks that matter here. @param {Uint8Array} attestationObject @param {string} rp */
export async function readAttestation(attestationObject, rp) {
  const top = cbor(attestationObject);
  const authData = top instanceof Map ? top.get("authData") : null;
  if (!(authData instanceof Uint8Array) || authData.length < 55) throw refuse("That passkey answer has no key in it.", "bad_attestation");
  const rpHash = await sha256(enc.encode(rp));
  for (let k = 0; k < 32; k++) if (authData[k] !== rpHash[k]) throw refuse("That passkey was made for another site.", "wrong_rp");
  const flags = authData[32];
  if ((flags & 0x05) !== 0x05) throw refuse("A passkey must be unlocked with Face ID, Touch ID or a PIN to be used here.", "no_user_verification");
  if ((flags & 0x40) === 0) throw refuse("That passkey answer carries no key.", "bad_attestation");
  const idLen = (authData[53] << 8) | authData[54];
  const credentialId = authData.slice(55, 55 + idLen);
  const cose = cbor(authData.slice(55 + idLen));
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw refuse("That passkey is not a P-256 key, which is what Vyre uses.", "bad_key_type");
  const x = cose.get(-2), y = cose.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw refuse("That passkey's key is not well formed.", "bad_key_type");
  const pub = new Uint8Array(65); pub[0] = 4; pub.set(x, 1); pub.set(y, 33);
  return { credentialId, pub };
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** An authenticator may return the high-s twin of an ECDSA signature; the chain accepts only the low-s one. DER in, DER out. @param {Uint8Array} der */
export function lowSDer(der) {
  if (der.length < 8 || der[0] !== 0x30 || der[2] !== 0x02) return der;
  const rl = der[3], r = der.slice(4, 4 + rl);
  if (der[4 + rl] !== 0x02) return der;
  const sl = der[5 + rl], s = der.slice(6 + rl, 6 + rl + sl);
  let v = 0n; for (const x of s) v = (v << 8n) | BigInt(x);
  if (v <= N / 2n) return der;
  let t = N - v; const out = []; while (t > 0n) { out.unshift(Number(t & 255n)); t >>= 8n; }
  if (out[0] & 0x80) out.unshift(0);
  const body = [0x02, rl, ...r, 0x02, out.length, ...out];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** The signer both a new passkey and a restored one use: the assertion over `message`, as the envelope the chain verifies. @param {any} wa @param {string} rp @param {Uint8Array} credentialId @param {number} timeout */
const assertionSigner = (wa, rp, credentialId, timeout) => async (/** @type {Uint8Array} */ message) => {
  let got;
  try {
    got = await wa.get({ publicKey: { challenge: await sha256(message), rpId: rp, allowCredentials: [{ type: "public-key", id: credentialId }], userVerification: "required", timeout } });
  } catch (e) { throw refuse(/** @type {any} */ (e) && /** @type {any} */ (e).name === "NotAllowedError" ? "That was not approved (cancelled, or it timed out)." : "This device could not use the passkey.", "passkey_refused"); }
  const r = got && got.response;
  if (!r) throw refuse("That was not approved.", "passkey_refused");
  return enc.encode(JSON.stringify({ ad: b64u(bytes(r.authenticatorData)), cd: b64u(bytes(r.clientDataJSON)), s: b64u(lowSDer(bytes(r.signature))) }));
};

/** The one origin a release build makes passkeys on: a passkey belongs to its relying party, so it works only here. */
export const PASSKEY_ORIGIN = "https://app.vyre.run";
/** What the person reads on any other origin. A space's own web app at name.vyre.run, or a custom domain, does not reuse the passkey: it enrols as its own device with the typed code. */
export const WRONG_ORIGIN_SAY = "Open app.vyre.run to create your name.";

/**
 * The relying-party id a passkey may be made for on this page, or null. A release build accepts only https://app.vyre.run; a development build also accepts http://localhost (any port), for walks and tests.
 * The Windows app's window (`shell`) may also make one for its own pages: the server it is paired to (`https://<name>.vyre.run`, an own domain is not taken) and the shell's bundled first-run page
 * (`https://vyreapp.localhost`). The Hello prompt names that site every time, so a script on the page cannot use the passkey silently; and a passkey is only ever good for the site it was made for.
 * @param {string | undefined} origin the page's origin @param {{ dev?: boolean, shell?: boolean }} [o] @returns {string | null}
 */
export function passkeyRp(origin, { dev = false, shell = false } = {}) {
  if (origin === PASSKEY_ORIGIN) return "app.vyre.run";
  if (shell && typeof origin === "string") {
    const m = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vyre\.run|vyreapp\.localhost)$/.exec(origin);
    if (m) return m[1];
  }
  if (dev && typeof origin === "string" && /^http:\/\/localhost(:\d{1,5})?$/.test(origin)) return "localhost";
  return null;
}

/**
 * Make a passkey and return it as a device key `claim.js` can use. Asks the person once now (making it) and once for each thing it signs.
 * @param {{ rp: string, name?: string, webauthn?: { create(o: any): Promise<any>, get(o: any): Promise<any> }, random?: (n: number) => Uint8Array, timeout?: number }} o
 * @returns {Promise<{ publicKey: string, eid: string, software: false, alg: "webauthn-es256", rp: string, credentialId: string, sign(message: Uint8Array): Promise<Uint8Array>, keep(): any }>}
 */
export async function createPasskeyKey(o) {
  const rp = String(o.rp || "");
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(rp)) throw refuse("A passkey is made for a site name.", "bad_rp");
  const wa = o.webauthn || (typeof navigator !== "undefined" && navigator.credentials ? { create: (/** @type {any} */ x) => navigator.credentials.create(x), get: (/** @type {any} */ x) => navigator.credentials.get(x) } : null);
  if (!wa) throw refuse("This browser cannot make a passkey. Use the app, or the code on your other device.", "no_webauthn");
  const random = o.random ?? (n => crypto.getRandomValues(new Uint8Array(n)));
  const timeout = o.timeout ?? 120_000;
  let cred;
  try {
    cred = await wa.create({ publicKey: {
      rp: { id: rp, name: "Vyre" }, user: { id: random(16), name: o.name || "Vyre", displayName: o.name || "Vyre" }, challenge: random(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, attestation: "none", timeout,
    } });
  } catch (e) {
    // The browser itself refuses a passkey for a relying party this origin does not own (SecurityError): the same answer as an origin passkeyRp turns away.
    if (e && /** @type {any} */ (e).name === "SecurityError") throw refuse(WRONG_ORIGIN_SAY, "wrong_origin");
    throw refuse(/** @type {any} */ (e) && /** @type {any} */ (e).name === "NotAllowedError" ? "The passkey was not made (cancelled, or it timed out)." : "This device could not make a passkey.", "passkey_refused"); }
  if (!cred || !cred.response) throw refuse("The passkey was not made.", "passkey_refused");
  const { credentialId, pub } = await readAttestation(bytes(cred.response.attestationObject), rp);
  const eid = await eidOf(pub);
  return {
    publicKey: b64u(pub), eid, software: false, alg: "webauthn-es256", rp, credentialId: b64u(credentialId),
    sign: assertionSigner(wa, rp, credentialId, timeout),
    keep: () => ({ kind: "passkey", rp, credentialId: b64u(credentialId), publicKey: b64u(pub) }),
  };
}

/** The passkey a stored `keep()` names, to sign with again (the credential stays in the authenticator; only its id and public key are kept). @param {any} kept @param {{ webauthn?: any, timeout?: number }} [o] */
export function restorePasskeyKey(kept, o = {}) {
  if (!kept || kept.kind !== "passkey") throw refuse("That is not a passkey.", "bad_key");
  const wa = o.webauthn || { create: (/** @type {any} */ x) => navigator.credentials.create(x), get: (/** @type {any} */ x) => navigator.credentials.get(x) };
  const credentialId = unb64(kept.credentialId), pub = unb64(kept.publicKey);
  if (!credentialId || !pub) throw refuse("That is not a passkey.", "bad_key");
  const rp = String(kept.rp);
  return eidOf(pub).then(eid => ({
    publicKey: kept.publicKey, eid, software: /** @type {false} */ (false), alg: /** @type {"webauthn-es256"} */ ("webauthn-es256"), rp, credentialId: kept.credentialId,
    sign: assertionSigner(wa, rp, credentialId, o.timeout ?? 120_000),
    keep: () => kept,
  }));
}

/** The fixed front of a P-256 SubjectPublicKeyInfo: the key's own 65-byte uncompressed point follows. */
const SPKI_P256 = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);

/**
 * The presence key a passkey-claimed browser offers in its pairing hello: the passkey itself, as a P-256 SPKI (base64url), alg -7, signer "webauthn_platform" and the site it is for. The box enrols it as the
 * device's presence key (unattested), and a yes from it is a WebAuthn assertion over the proof's bytes.
 * @param {{ kind?: string, rp?: string, publicKey?: string } | null | undefined} kept what keep() gave
 * @returns {{ key: string, alg: -7, storage: "hardware", signer: "webauthn_platform", rp: string } | null}
 */
export function passkeyPresenceKey(kept) {
  if (!kept || kept.kind !== "passkey" || typeof kept.rp !== "string" || typeof kept.publicKey !== "string") return null;
  const pub = unb64(kept.publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4) return null;
  const spki = new Uint8Array(SPKI_P256.length + 65); spki.set(SPKI_P256, 0); spki.set(pub, SPKI_P256.length);
  const key = b64u(spki);
  return { key, alg: -7, storage: "hardware", signer: "webauthn_platform", rp: kept.rp };
}
