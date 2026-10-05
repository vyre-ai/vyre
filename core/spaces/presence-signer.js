// @ts-check
// spaces: how this computer answers a space home's presence challenge for the person (the owner inviting someone to a space on a server is an outward yes).
// A person's hardware signer (Touch ID, the Secure Enclave, a passkey) answers through `hooks.signer`; nothing here makes that key. The one thing made here is a SOFTWARE key kept in a 0600 file,
// and it answers only on a development build behind VYRE_SEAL_SOFTWARE (the home's sealing process refuses a software key on a release-kind build in the same way, `software_refused`).
// The proof is the kernel's own PresenceProof plus two signed fields, `home` and `challenge` (kernel/core/presence.js remoteBinding).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { proofBytes, payloadHash } from "../../kernel/core/presence.js";
import { presenceKeyId } from "../../lib/presence-key-id.js";
import { proofChainHash } from "../../kernel/remote/proof.js";

const PROOF_LIFE_MS = 60_000;

/**
 * The software presence key of this computer, as the sealing process takes it at enrolment: `{ key_id, spki (base64), signer: "software" }` (public data only).
 * @param {string} file the key file (made 0600 on first use)
 */
export function softwareKey(file) {
  /** @type {crypto.KeyObject | null} */ let priv = null;
  try { priv = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(file, "utf8")), format: "jwk" }); } catch { priv = null; }
  if (!priv) {
    priv = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(priv.export({ format: "jwk" })), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* not posix */ }
  }
  const key = priv;
  const spki = crypto.createPublicKey(key).export({ format: "der", type: "spki" });
  return { key_id: presenceKeyId(spki), spki: spki.toString("base64"), signer: /** @type {const} */ ("software"), sign: (/** @type {Buffer} */ m) => crypto.sign("sha256", m, { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

/**
 * WN-1: the signer works out what it signs. The payload hash is recomputed here from the op, the space and the fields (never taken from the challenge), and a challenge whose own hash is not
 * that, or that is not for the request this device made (`expect`, built from the device's own call), is refused: a home asking for a signature over something else gets none.
 * @param {{ op?: string, fields?: any, payload_hash?: string, space?: string }} ch @param {{ op: string, space: string, fields: any, payload_hash: string } | undefined} [expect]
 * @returns {string | null} the reason it must not be signed, or null
 */
export function challengeProblem(ch, expect) {
  if (!ch || typeof ch.op !== "string" || typeof ch.space !== "string" || !ch.fields || typeof ch.fields !== "object") return "no_challenge";
  const own = payloadHash(ch.op, ch.space, ch.fields);
  if (typeof ch.payload_hash !== "string" || ch.payload_hash !== own) return "hash_mismatch";
  if (expect && (ch.op !== expect.op || ch.space !== expect.space || own !== expect.payload_hash)) return "not_this_request";
  return null;
}

/**
 * A PresenceProof over the home's challenge, or null when the challenge does not say what to sign or is not what it claims (see `challengeProblem`). The hash that is signed is the one worked out here.
 * @param {string} file @param {string} person the identity id the home knows this person by @param {{ op?: string, fields?: any, payload_hash?: string, home?: string, nonce?: string, space?: string }} ch @param {() => number} [now] @param {{ op: string, space: string, fields: any, payload_hash: string }} [expect] what this device itself asked for
 */
export function softwareProof(file, person, ch, now = Date.now, expect) {
  if (!ch || typeof ch.nonce !== "string" || typeof ch.home !== "string" || !ch.nonce || challengeProblem(ch, expect)) return null;
  const key = softwareKey(file);
  const issued = now();
  const body = { signer: key.signer, key_id: key.key_id, payload_hash: payloadHash(/** @type {string} */ (ch.op), /** @type {string} */ (ch.space), ch.fields), decision: ch.op, chain_hash: proofChainHash(/** @type {string} */ (ch.space), person), issued_at: issued, expires_at: issued + PROOF_LIFE_MS, nonce: crypto.randomBytes(8).toString("base64url"), home: ch.home, challenge: ch.nonce };
  return { ...body, signature: key.sign(proofBytes(body)) };
}

/**
 * A PresenceProof for the person's own act on a space (accepting an invite): over the request the kernel built (`op`, `payload_hash`, the space), with no home or challenge, because no home asked for it.
 * @param {string} file @param {string} person @param {{ op?: string, fields?: any, payload_hash?: string, space?: string }} req
 */
export function softwareActProof(file, person, req) {
  if (!req || typeof req.space !== "string" || challengeProblem({ op: req.op, space: req.space, fields: /** @type {any} */ (req).fields, payload_hash: req.payload_hash })) return null;
  const key = softwareKey(file);
  const issued = Date.now();
  const body = { signer: key.signer, key_id: key.key_id, payload_hash: payloadHash(/** @type {string} */ (req.op), req.space, /** @type {any} */ (req).fields), decision: req.op, chain_hash: proofChainHash(req.space, person), issued_at: issued, expires_at: issued + PROOF_LIFE_MS, nonce: crypto.randomBytes(8).toString("base64url") };
  return { ...body, signature: key.sign(proofBytes(body)) };
}
