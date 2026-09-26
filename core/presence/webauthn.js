// @ts-check
import crypto from "node:crypto";

/** Base64url (or base64, with or without padding) to bytes. */
const b64 = (/** @type {string} */ s) => {
  if (typeof s !== "string") throw new Error("not a string");
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
};
const norm = (/** @type {string} */ s) => String(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest();

/**
 * Check a WebAuthn assertion made with user verification. Never throws.
 * @param {{ publicKey: string, alg: number, rpId: string, challenge: string, authenticatorData: string,
 *   clientDataJSON: string, signature: string, origins?: string[] }} a
 * @returns {{ ok: true, signCount: number } | { ok: false, reason: string }}
 */
export function verifyAssertion(a) {
  try {
    const { publicKey, alg, rpId, challenge, authenticatorData, clientDataJSON, signature, origins } = a;
    const cdBytes = b64(clientDataJSON);
    let cd;
    try { cd = JSON.parse(cdBytes.toString("utf8")); } catch { return { ok: false, reason: "clientData is not JSON" }; }
    if (!cd || typeof cd !== "object") return { ok: false, reason: "clientData is not an object" };
    if (cd.type !== "webauthn.get") return { ok: false, reason: "wrong type" };
    if (typeof cd.challenge !== "string" || typeof challenge !== "string" || !challenge || norm(cd.challenge) !== norm(challenge)) {
      return { ok: false, reason: "wrong challenge" };
    }
    if (Array.isArray(origins) && !origins.includes(cd.origin)) return { ok: false, reason: "origin not allowed" };

    const ad = b64(authenticatorData);
    if (ad.length < 37) return { ok: false, reason: "authenticatorData too short" };
    if (typeof rpId !== "string" || !ad.subarray(0, 32).equals(sha256(Buffer.from(rpId, "utf8")))) {
      return { ok: false, reason: "wrong rpId" };
    }
    const flags = ad[32];
    if (!(flags & 0x01)) return { ok: false, reason: "user not present" };
    if (!(flags & 0x04)) return { ok: false, reason: "user not verified" };
    const signCount = ad.readUInt32BE(33);

    const signed = Buffer.concat([ad, sha256(cdBytes)]);
    const key = { key: b64(publicKey), format: /** @type {const} */ ("der"), type: /** @type {const} */ ("spki") };
    const sig = b64(signature);
    let good;
    if (alg === -7) good = crypto.verify("sha256", signed, { ...key, dsaEncoding: "der" }, sig);
    else if (alg === -8) good = crypto.verify(null, signed, key, sig);
    else if (alg === -257) good = crypto.verify("sha256", signed, key, sig);
    else return { ok: false, reason: "unsupported alg" };
    return good ? { ok: true, signCount } : { ok: false, reason: "bad signature" };
  } catch (e) {
    return { ok: false, reason: "malformed assertion: " + /** @type {Error} */ (e).message };
  }
}
