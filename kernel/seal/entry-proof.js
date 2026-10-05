// @ts-check
// kernel/seal/entry-proof.js: does a platform attestation prove that a device's chip key (the `enclave` point on its identity entry) lives in the OS's key store (KP-2)? Pairing offers an entry; the identity list
// takes it as held "web" (a key a page script can reach, no say over who speaks for the identity) unless this says yes. Node built-ins only, like the rest of kernel/seal.
//
// The attestation names THIS enrolment. Apple: clientDataHash = SHA256("vyre-enrol\n" + "entry:" + <the entry's Ed25519 key, base64url> + "\n" + <the chip key's SPKI as base64 text>), the sealing enrol's own hash (appattest.js
// enrolClientData) with a token that is the entry's own key. Android: the challenge is SHA256("vyre-enrol\nentry:" + <the entry's key> + "\n") (Keystore takes it before the key exists) and the leaf's public point must be the
// chip key. So an attestation made for one entry or one chip key proves nothing for another. The offered `attest` is base64url of JSON
// { format: "apple-appattest", keyId, attestation } (the CBOR attestation object, base64url) or { format: "android-key", chain: [base64 DER certificate, leaf first] }. It is verified here (Android also against Google's revocation list) and NOT stored on the list.
// Each verifier is closed until its real-device fixture passes (APPATTEST_VERIFIED, ANDROID_ATTEST_VERIFIED): while closed, nothing is proven and every paired entry stays web.
import { appAttestVerifier, enrolClientData } from "./appattest.js";
import { androidAttestVerifier } from "./androidattest.js";

const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
/** The token an entry's attestation is bound to. @param {string} publicKey the entry's Ed25519 key, base64url */
export const entryToken = publicKey => `entry:${publicKey}`;
/** The SPKI (DER, base64 text) of a raw 65-byte P-256 point. @param {Buffer} point */
export const spkiB64 = point => Buffer.concat([SPKI_P256, point]).toString("base64");
/** The hash an Apple attestation of this entry's chip key must carry: the sealing enrol's own hash over the entry's token and the chip key. @param {string} publicKey @param {Buffer} point */
export const entryClientData = (publicKey, point) => enrolClientData(entryToken(publicKey), spkiB64(point));
/**
 * The challenge an Android Keystore attestation must carry: SHA256("vyre-enrol\nentry:" + the entry's key + "\n"). Keystore takes the challenge when it creates the key, before the key's public point exists, so the chip key
 * cannot be in it; the verifier instead checks that the leaf certificate's public point IS the entry's `enclave` (androidattest.js). A key made before pairing keeps its old challenge and so proves nothing.
 * @param {string} publicKey
 */
export const androidChallenge = publicKey => enrolClientData(entryToken(publicKey), "");

/**
 * @param {{ apple?: ReturnType<typeof appAttestVerifier>, android?: ReturnType<typeof androidAttestVerifier> }} [o]
 * @returns {(entry: { publicKey: string, enclave?: string, agree?: string, attest?: string }, meta?: any) => Promise<boolean>} true only when a verifier accepted an attestation of this entry's chip key
 */
export function entryProof({ apple = appAttestVerifier(), android = androidAttestVerifier() } = {}) {
  return async entry => {
    try {
      if (!entry || typeof entry.publicKey !== "string" || typeof entry.enclave !== "string" || typeof entry.attest !== "string" || entry.attest.length > 16384) return false;
      const point = Buffer.from(entry.enclave, "base64url");
      if (point.length !== 65 || point[0] !== 4) return false;
      const a = JSON.parse(Buffer.from(entry.attest, "base64url").toString("utf8"));
      if (!a || typeof a !== "object") return false;
      if (a.format === "apple-appattest") return apple.enrol({ attestation: a.attestation, key_id: a.keyId }, spkiB64(point), entryToken(entry.publicKey)) !== null;
      if (a.format === "android-key") return android.check(a, point, androidChallenge(entry.publicKey)) !== null && !(await android.revoked(a));
      return false;
    } catch { return false; }
  };
}
