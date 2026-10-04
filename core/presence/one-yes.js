// @ts-check
// One yes (DESIGN-one-yes.md, ruling c328cd1): the whole permission layer is two questions, asked in one place.
//   isYou(subject)  Is this call YOU (a verified person surface: a paired device, the terminal, the Capsule, the app)? A kernel chain is you only when it is exactly one person; a call (its meta) is you
//                   when lib/caller's verified person check says so. An agent, a model, a module, a guest is never you.
//   yes(moment, request, proof)  Is there a fresh yes from one of your REAL devices (Secure Enclave, Android keystore, passkey, Touch ID) over this exact request, for one of the three moments (pairing a
//                   new device, a vault secret, an outward send/post/pay)? { ok: true } or { ok: false, reason } with reason one of YES_REASONS. A software key is a yes only where the build takes software keys
//                   (a development build); on a release build it answers software_key.
// The verifier is the sealing process's one proof check (kernel/seal), given once by the daemon with `configureYes`; with none configured every yes is refused (no_proof): it fails closed.
import { isPerson } from "../../lib/caller.js";

/** The three moments a yes is asked at (the user's standing rule). */
export const MOMENTS = Object.freeze(["pair", "vault", "outward"]);
/** Why a yes was refused. */
export const YES_REASONS = Object.freeze(["no_proof", "expired", "replayed", "wrong_request", "software_key", "unknown_key"]);

/** @param {any} chain */
const isChainOfOnePerson = chain => Boolean(chain && Array.isArray(chain.hops) && chain.viewer !== true && chain.hops.length === 1 && chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.kind === "person");

/**
 * Is this you? `subject` is a kernel chain ({ hops }) or a call's meta ({ caller }) or a caller label.
 * @param {any} subject @returns {boolean}
 */
export function isYou(subject) {
  if (subject && typeof subject === "object" && Array.isArray(subject.hops)) return isChainOfOnePerson(subject);
  if (subject && typeof subject === "object" && subject.chain && Array.isArray(subject.chain.hops)) return isChainOfOnePerson(subject.chain);
  try { return isPerson(subject); } catch { return false; }
}

/** @typedef {(i: { chain?: any, op: string, fields: any, proof: any, moment: string }) => Promise<null | string | { ok: boolean, code?: string, reason?: string, strength?: string }> | null | string | { ok: boolean, code?: string, reason?: string, strength?: string }} Verifier */
/** @type {{ verify: Verifier | null, softwareOk: () => boolean }} */
const state = { verify: null, softwareOk: () => false };

/**
 * The daemon's one wiring: the proof verifier (it answers null when the proof stands, else a reason code, or { ok, code, strength }) and whether this build takes software keys.
 * @param {{ verify: Verifier | null, softwareOk?: () => boolean }} o
 */
export function configureYes(o) {
  state.verify = o && typeof o.verify === "function" ? o.verify : null;
  state.softwareOk = o && typeof o.softwareOk === "function" ? o.softwareOk : () => false;
}

/** The sealing process's reason codes, mapped onto the six words a caller sees. Anything unlisted is refused as no_proof (fail closed). @param {unknown} code */
export function yesReason(code) {
  switch (String(code)) {
    case "expired": return "expired";
    case "replayed": case "used": return "replayed";
    case "wrong_decision": case "wrong_payload": case "wrong_request": case "wrong_op": case "wrong_fields": case "bad_signature": case "bad": case "chain_not_person": case "bad_chain": return "wrong_request";
    case "software_key": case "software": return "software_key";
    case "unknown_key": case "key_revoked": case "not_found": case "newcomer": case "needs_bind": case "needs_other_key": return "unknown_key";
    default: return "no_proof";
  }
}

/**
 * A fresh yes for one of the three moments.
 * @param {string} moment one of MOMENTS
 * @param {{ chain?: any, op: string, fields: any }} request the exact thing the proof was made over
 * @param {any} proof the signed proof object
 * @param {{ verify?: Verifier | null, softwareOk?: () => boolean }} [via] a test seam; the daemon's configuration is the default
 * @returns {Promise<{ ok: true, strength?: string } | { ok: false, reason: string }>}
 */
export async function yes(moment, request, proof, via = {}) {
  if (!MOMENTS.includes(/** @type {any} */ (moment))) return { ok: false, reason: "wrong_request" };
  if (!request || typeof request !== "object" || typeof request.op !== "string" || !/^[a-z][a-z0-9_.-]{1,80}$/.test(request.op) || !request.fields || typeof request.fields !== "object" || Array.isArray(request.fields)) return { ok: false, reason: "wrong_request" };
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return { ok: false, reason: "no_proof" };
  const verify = via.verify !== undefined ? via.verify : state.verify;
  if (typeof verify !== "function") return { ok: false, reason: "no_proof" };
  const softwareOk = via.softwareOk || state.softwareOk;
  /** @type {any} */ let r;
  try { r = await verify({ ...(request.chain ? { chain: request.chain } : {}), op: request.op, fields: request.fields, proof, moment }); } catch { return { ok: false, reason: "no_proof" }; }
  if (r === null || r === undefined) return { ok: true };
  if (typeof r === "string") return { ok: false, reason: yesReason(r) };
  if (r && typeof r === "object") {
    if (r.ok === true) {
      // a software key is a yes only where the build takes software keys
      if (r.strength === "software" && !(() => { try { return softwareOk() === true; } catch { return false; } })()) return { ok: false, reason: "software_key" };
      return { ok: true, ...(r.strength ? { strength: r.strength } : {}) };
    }
    return { ok: false, reason: yesReason(r.code || r.reason) };
  }
  return { ok: false, reason: "no_proof" };
}
