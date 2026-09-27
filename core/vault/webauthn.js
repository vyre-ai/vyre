// @ts-check
// webauthn: the vault as a software passkey provider, the WebAuthn Level 3 math and nothing else.
//
// The browser extension stands in for navigator.credentials.create and .get and hands the request
// to vyred, which holds the private key and signs, as 1Password and Bitwarden do. A relying party
// cannot tell a software authenticator from a platform one except by AAGUID, so every byte here has
// to be what a server library expects: clientDataJSON in the spec's key order, authenticatorData as
// rpIdHash || flags || counter || attested credential data, a "none" attestation in canonical CBOR,
// and a DER ECDSA signature. Only ES256 (P-256, COSE -7) is offered; every browser and server
// accepts it.
//
// The passkey is synced (BE and BS set) so the counter stays 0, as Apple and Google do: a counter
// that cannot move backwards across devices is worse than none. Storing the credential and asking
// for presence (Touch ID) are the caller's. Pure apart from key generation and randomness; no disk,
// no network. Errors carry the DOMException names a page would see (SecurityError,
// NotSupportedError) so the extension can rethrow them as-is.

import crypto from "node:crypto";

/** The Vyre authenticator's AAGUID. Fixed forever: relying parties key on it to name the provider. */
export const AAGUID = "9700b56e-127f-445c-a7ca-560431cc2b48";
const AAGUID_BYTES = Buffer.from(AAGUID.replace(/-/g, ""), "hex");

const ES256 = -7;
const RS256 = -257;
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

// A small public suffix list: the common ones a page could try to claim as its rpId. Single-label
// rpIds are refused separately, so only the multi-label suffixes and a few plain TLDs sit here.
const PUBLIC_SUFFIXES = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "io", "co", "dev", "app", "ai", "me", "sh", "uk", "au", "jp",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp",
  "co.in", "com.br", "com.cn", "com.mx", "com.sg", "com.hk", "co.za", "co.kr", "com.tr", "com.pk", "com.my",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app",
  "firebaseapp.com", "herokuapp.com", "appspot.com", "blogspot.com", "cloudfront.net",
  "azurewebsites.net", "fly.dev", "onrender.com", "up.railway.app", "s3.amazonaws.com", "glitch.me",
]);

/** @param {string} name @param {string} message */
function fail(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const sha256 = (/** @type {Uint8Array | string} */ d) => crypto.createHash("sha256").update(d).digest();

/**
 * Strict base64url (no padding, no stray characters) to bytes, within a length range.
 * @param {unknown} s @param {string} what @param {number} min @param {number} max
 */
function fromB64u(s, what, min, max) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new TypeError(`${what} is not base64url`);
  const buf = Buffer.from(s, "base64url");
  if (buf.length < min || buf.length > max) throw new TypeError(`${what} must be ${min} to ${max} bytes`);
  return buf;
}

const isIp = (/** @type {string} */ h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[");

/**
 * Whether a page at `origin` may use `rpId`: a secure origin (https, or http on localhost) whose
 * host is the rpId or a subdomain of it, where the rpId is not a public suffix. IP literals are
 * never a valid rpId (the spec wants a domain), so they are refused outright.
 * @param {unknown} rpId
 * @param {unknown} origin
 * @returns {boolean}
 */
export function rpIdAllowed(rpId, origin) {
  if (typeof rpId !== "string" || typeof origin !== "string") return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  // The serialized origin only: no path, no default port spelled out, no credentials.
  if (u.origin !== origin) return false;
  const host = u.hostname;
  if (u.protocol === "http:") { if (host !== "localhost") return false; }
  else if (u.protocol !== "https:") return false;
  if (isIp(host) || isIp(rpId)) return false;
  // Canonical form only, so the rpIdHash we sign is the one the server computes.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(rpId) || rpId.length > 253) return false;
  if (!rpId.includes(".") && rpId !== "localhost") return false;
  if (PUBLIC_SUFFIXES.has(rpId)) return false;
  return host === rpId || host.endsWith(`.${rpId}`);
}

/** Throws SecurityError unless the origin may use the rpId, and checks topOrigin when framed. */
function checkOrigin(/** @type {string} */ rpId, /** @type {string} */ origin, /** @type {boolean} */ crossOrigin, /** @type {unknown} */ topOrigin) {
  if (!rpIdAllowed(rpId, origin)) throw fail("SecurityError", `the origin ${String(origin)} may not use the rp id ${String(rpId)}`);
  if (typeof crossOrigin !== "boolean") throw new TypeError("crossOrigin must be a boolean");
  if (crossOrigin) {
    let ok = false;
    try { ok = typeof topOrigin === "string" && new URL(topOrigin).origin === topOrigin; } catch { /* not a URL */ }
    if (!ok) throw fail("SecurityError", "a cross-origin request needs a topOrigin");
  }
}

// ---- CBOR (RFC 8949), the encoding subset WebAuthn needs: definite lengths, shortest heads. ----

/** @param {number} major @param {number | bigint} n */
function head(major, n) {
  const m = major << 5;
  if (typeof n === "bigint" || n > 0xffffffff) {
    const b = Buffer.alloc(9); b[0] = m | 27; b.writeBigUInt64BE(BigInt(n), 1); return b;
  }
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(n, 1); return b;
}

/**
 * Encode integers, byte strings, text, arrays and maps. A Map keeps its keys (numbers or strings)
 * in the order given; a plain object is a map with text keys.
 * @param {unknown} v
 * @returns {Buffer}
 */
function cborEncode(v) {
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new TypeError("CBOR: only integers are supported");
    return v >= 0 ? head(0, v) : head(1, typeof v === "bigint" ? -1n - v : -1 - v);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const t = Buffer.from(v, "utf8"); return Buffer.concat([head(3, t.length), t]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  const entries = v instanceof Map ? [...v.entries()] : v && typeof v === "object" ? Object.entries(v) : null;
  if (!entries) throw new TypeError(`CBOR: cannot encode ${typeof v}`);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
}

// ---- The authenticator. ----

/** clientDataJSON in the spec's order; topOrigin only when framed cross-origin. */
function clientData(/** @type {string} */ type, /** @type {string} */ challenge, /** @type {string} */ origin, /** @type {boolean} */ crossOrigin, /** @type {string | undefined} */ topOrigin) {
  let s = `{"type":${JSON.stringify(type)},"challenge":${JSON.stringify(challenge)},"origin":${JSON.stringify(origin)},"crossOrigin":${crossOrigin}`;
  if (crossOrigin) s += `,"topOrigin":${JSON.stringify(topOrigin)}`;
  return Buffer.from(`${s}}`, "utf8");
}

/** rpIdHash || flags || signCount, then the attested credential data when there is some. */
function authData(/** @type {string} */ rpId, /** @type {number} */ flags, /** @type {number} */ signCount, /** @type {Buffer} */ attested = Buffer.alloc(0)) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount >>> 0);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, attested]);
}

/**
 * Make a new passkey for a relying party (navigator.credentials.create).
 * @param {{ rpId: string, origin: string, challenge: string, user: { id: string, name: string, displayName: string },
 *   algs: number[], crossOrigin?: boolean, topOrigin?: string }} opts
 */
export function createCredential({ rpId, origin, challenge, user, algs, crossOrigin = false, topOrigin }) {
  checkOrigin(rpId, origin, crossOrigin, topOrigin);
  fromB64u(challenge, "challenge", 16, 1024);
  if (!user || typeof user !== "object") throw new TypeError("user is required");
  const userId = fromB64u(user.id, "user.id", 1, 64);
  if (typeof user.name !== "string" || typeof user.displayName !== "string") throw new TypeError("user.name and user.displayName must be strings");
  if (!Array.isArray(algs)) throw new TypeError("algs must be an array of COSE algorithm numbers");
  // An empty pubKeyCredParams means the spec's defaults, ES256 then RS256.
  const offered = algs.length ? algs : [ES256, RS256];
  if (!offered.includes(ES256)) throw fail("NotSupportedError", "only ES256 (-7) passkeys are supported");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(String(jwk.x), "base64url"), y = Buffer.from(String(jwk.y), "base64url");
  const cose = cborEncode(new Map([[1, 2], [3, ES256], [-1, 1], [-2, x], [-3, y]]));
  const spki = /** @type {Buffer} */ (publicKey.export({ type: "spki", format: "der" }));
  const credId = crypto.randomBytes(16);

  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(credId.length);
  const flags = FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS | FLAG.AT;
  const auth = authData(rpId, flags, 0, Buffer.concat([AAGUID_BYTES, idLen, credId, cose]));
  const attestationObject = cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", auth]]));
  const cdj = clientData("webauthn.create", challenge, origin, crossOrigin, topOrigin);
  const id = b64u(credId);

  return {
    credential: {
      id, rpId, userHandle: b64u(userId), userName: user.name, displayName: user.displayName,
      privateKey: /** @type {string} */ (privateKey.export({ type: "pkcs8", format: "pem" })),
      publicKey: b64u(cose), signCount: 0, created: new Date().toISOString(),
    },
    response: {
      id, rawId: id, type: "public-key", authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: b64u(cdj), attestationObject: b64u(attestationObject), authenticatorData: b64u(auth),
        publicKey: b64u(spki), publicKeyAlgorithm: ES256, transports: ["internal", "hybrid"],
      },
    },
  };
}

/**
 * Sign in with a stored passkey (navigator.credentials.get).
 * @param {{ credential: { id: string, rpId: string, userHandle: string, privateKey: string, signCount?: number },
 *   origin: string, challenge: string, crossOrigin?: boolean, topOrigin?: string }} opts
 */
export function getAssertion({ credential, origin, challenge, crossOrigin = false, topOrigin }) {
  if (!credential || typeof credential !== "object") throw new TypeError("credential is required");
  checkOrigin(credential.rpId, origin, crossOrigin, topOrigin);
  fromB64u(challenge, "challenge", 16, 1024);
  fromB64u(credential.id, "credential.id", 1, 1023);
  // Synced: the counter is not advanced, so it stays at whatever was stored (0).
  const signCount = Number(credential.signCount) || 0;
  const auth = authData(credential.rpId, FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS, signCount);
  const cdj = clientData("webauthn.get", challenge, origin, crossOrigin, topOrigin);
  const signature = crypto.sign("sha256", Buffer.concat([auth, sha256(cdj)]), { key: credential.privateKey, dsaEncoding: "der" });
  return {
    response: {
      id: credential.id, rawId: credential.id, type: "public-key", authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(auth), signature: b64u(signature), userHandle: credential.userHandle },
    },
    signCount,
  };
}
