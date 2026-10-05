// @ts-check
// One yes (DESIGN-one-yes.md, ruling c328cd1): the whole permission layer is two questions, asked in one place.
//   isYou(subject)  Is this call YOU (a verified person surface: a paired device, the terminal, the Capsule, the app)? A kernel chain is you only when it is exactly one person; a call (its meta) is you
//                   when lib/caller's verified person check says so. An agent, a model, a module, a guest is never you.
//   yes(moment, request, proof)  Is there a fresh yes from one of your REAL devices (Secure Enclave, Android keystore, passkey, Touch ID) over this exact request, for one of the three moments (pairing a
//                   new device, a vault secret, an outward send/post/pay)? { ok: true } or { ok: false, reason } with reason one of YES_REASONS. A software key is a yes only where the build takes software keys
//                   (a development build); on a release build it answers software_key.
// The verifier is the sealing process's one proof check (kernel/seal), given once by the daemon with `configureYes`; with none configured every yes is refused (no_proof): it fails closed.
import { isPerson } from "./caller.js";

/** The three moments a yes is asked at (the user's standing rule). */
export const MOMENTS = Object.freeze(["pair", "vault", "outward"]);
/** Why a yes was refused. */
export const YES_REASONS = Object.freeze(["no_proof", "expired", "replayed", "wrong_request", "software_key", "unknown_key"]);

/**
 * What the owner's key signs for a moment: the sealing process takes `task.*` and `grant.*` acts, so each moment has one act word, and the card's own op and plain fields ride in the fields.
 * The card shows this (`sign`), the phone signs exactly it, and the verifier checks exactly it.
 * @param {string} moment @param {{ op: string, fields: any }} request @returns {{ op: string, fields: Record<string, any> }}
 */
export function signOf(moment, request) {
  const act = moment === "pair" ? "grant.pair_device" : moment === "vault" ? "task.vault_use" : "task.outward_act";
  // fixed keys, the request's own fields nested under one of them: no field of any request can override the op, and two different requests never sign the same bytes
  return { op: act, fields: { what: request.op, fields: request.fields && typeof request.fields === "object" ? request.fields : {} } };
}

/** The card store's redeemer, set by the presence module: a card the owner's phone approved (its proof already verified when it was given) is spent ONCE by the asking device's act. @type {null | ((id: string, moment: string, request: { op: string, fields: any }, device: string | null) => "ok" | "replayed" | "wrong_request" | "no_proof")} */
let redeemCard = null;
/** @param {typeof redeemCard} fn */
/**
 * The tools each moment covers: an explicit allowlist, never a prefix. A card, and an approval at the registry's floor, exist only for these; any other tool (removing a device, resetting a server, deleting or
 * exporting from the vault, inviting someone) is refused at ask and at the floor, however its name begins. The outward moment is any tool marked `outward` in its module.json; the registry's `isOutward` is the one source and is passed in (none given: nothing is outward).
 */
export const MOMENT_OPS = Object.freeze({
  pair: Object.freeze(["presence.enroll", "link.pair.approve", "wink.phone.pair.answer", "wink.server.pair.answer", "wink.pair.server",
    // starting a pairing or turning the relay on is the same weight as answering one: a proof signed over the call itself (software strength on a development build only)
    "wink.phone.open", "relay.pair.start", "relay.enable",
    // typing back the code a new device shows is the owner's yes to adding it
    "wink.code.ack"]),
  vault: Object.freeze(["vault.reveal", "vault.copy", "vault.totp", "vault.inject", "vault.resolve", "vault.render"]),
});
/** @typedef {(op: string) => boolean} OutwardCheck */
/** Is this op one the moment covers? @param {string} moment @param {string} op @param {OutwardCheck} [isOutward] the registry's flag read (ctx.modules.isOutward) */
export const opFitsMoment = (moment, op, isOutward) => (moment === "pair" || moment === "vault" ? MOMENT_OPS[moment].includes(String(op)) : moment === "outward" ? outwardOf(isOutward, op) : false);
/** @param {OutwardCheck | undefined} fn @param {string} op */
const outwardOf = (fn, op) => { try { return typeof fn === "function" && /^[a-z][a-z0-9-]*\.[a-z0-9.-]{1,80}$/.test(String(op)) && fn(String(op)) === true; } catch { return false; } };
/**
 * Which of the three moments a tool is, by its name (the one place: the registry asks this to accept an approval for a floor-bearing tool), or null.
 * @param {string} tool @param {OutwardCheck} [isOutward] @returns {"pair" | "vault" | "outward" | null}
 */
export function momentOf(tool, isOutward) {
  const t = String(tool);
  if (MOMENT_OPS.vault.includes(t)) return "vault";
  if (MOMENT_OPS.pair.includes(t)) return "pair";
  if (outwardOf(isOutward, t)) return "outward";
  return null;
}
/**
 * The sentence the owner's phone shows, written from the OP itself (never from the moment): what will happen, to what. An op without a sentence here is named, not described.
 * @param {string} op @param {Record<string, any>} fields @param {string} who the server's own name for the asking device
 */
export function lineOfOp(op, fields, who) {
  const name = fields && fields.name ? `"${String(fields.name).slice(0, 80)}"` : "a secret";
  const f = Object.entries(fields || {}).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(", ");
  /** @type {Record<string, string>} */
  const WHAT = {
    "vault.reveal": `show ${name} from your vault`, "vault.copy": `copy ${name} from your vault`, "vault.totp": `get the sign-in code for ${name}`,
    "vault.inject": `use ${name} from your vault in a command`, "vault.resolve": `use ${name} from your vault`, "vault.render": `fill in a file with ${name} from your vault`,
    "presence.enroll": "add a new key for you on this server", "link.pair.approve": "pair another machine with this one",
    "wink.phone.pair.answer": "pair a new phone", "wink.server.pair.answer": "pair this server to a new device", "wink.pair.server": "pair a server",
    "wink.phone.open": "show a code to add a phone", "wink.code.ack": "add the device whose code you typed", "relay.pair.start": "start adding a device", "relay.enable": "turn on the relay for this server",
  };
  const what = WHAT[op] || `run ${op}${f ? ` (${f})` : ""}`;
  return `${who} wants to ${what}`;
}

/** The plain fields of a call's input, or null when any is not plain data (a card is for plain fields only). @param {any} input @returns {Record<string, string | number | boolean> | null} */
export function plainFieldsOf(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  /** @type {Record<string, string | number | boolean>} */ const out = {};
  for (const k of Object.keys(input)) { const v = input[k]; if (!(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200))) return null; out[k] = v; }
  return out;
}

export function setCardRedeemer(fn) { redeemCard = typeof fn === "function" ? fn : null; }

/** @param {any} chain */
const isChainOfOnePerson = chain => Boolean(chain && Array.isArray(chain.hops) && chain.viewer !== true && chain.hops.length === 1 && chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.kind === "person");

/**
 * Is this you? `subject` is a kernel chain ({ hops }) or a call's meta ({ caller }) or a caller label.
 * @param {any} subject @returns {boolean}
 */
export function isYou(subject) {
  if (subject && typeof subject === "object" && Array.isArray(subject.hops)) return isChainOfOnePerson(subject);
  if (subject && typeof subject === "object" && subject.chain && Array.isArray(subject.chain.hops)) return isChainOfOnePerson(subject.chain);
  // a call that carries an agent or a thread is a model's, whatever its label says (a label is only a claim)
  if (subject && typeof subject === "object" && (subject.agent || subject.thread || subject.model)) return false;
  try { return isPerson(subject); } catch { return false; }
}

/** @typedef {(i: { chain?: any, op: string, fields: any, proof: any, moment: string, request?: { op: string, fields: any }, dry?: boolean }) => Promise<null | string | { ok: boolean, code?: string, reason?: string, strength?: string }> | null | string | { ok: boolean, code?: string, reason?: string, strength?: string }} Verifier */
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
 * @param {{ chain?: any, op: string, fields: any, device?: string }} request the exact thing the proof was made over (`device`: the paired device whose act this is, for a card)
 * @param {any} proof the signed proof object
 * @param {{ verify?: Verifier | null, softwareOk?: () => boolean, dry?: boolean }} [via] a test seam (and `dry`); the daemon's configuration is the default. `dry: true` asks the verifier to CHECK the proof without spending it (a card's answer is checked when it is given and spent when it is used)
 * @returns {Promise<{ ok: true, strength?: string } | { ok: false, reason: string }>}
 */
export async function yes(moment, request, proof, via = {}) {
  if (!MOMENTS.includes(/** @type {any} */ (moment))) return { ok: false, reason: "wrong_request" };
  if (!request || typeof request !== "object" || typeof request.op !== "string" || !/^[a-z][a-z0-9_.-]{1,80}$/.test(request.op) || !request.fields || typeof request.fields !== "object" || Array.isArray(request.fields)) return { ok: false, reason: "wrong_request" };
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return { ok: false, reason: "no_proof" };
  // a card the owner's phone already approved: its proof was checked (and spent) when the phone gave it; the asking device's act spends the card, once, for exactly that request
  if (typeof proof.card === "string") {
    // the asking device is mandatory and comes from the verified call (never from the client): a redeem that names no device spends nothing
    const device = typeof request.device === "string" && request.device ? request.device : null;
    const r = redeemCard && device ? redeemCard(proof.card, moment, { op: request.op, fields: request.fields }, device) : "no_proof";
    return r === "ok" ? { ok: true, strength: "real" } : { ok: false, reason: r };
  }
  const verify = via.verify !== undefined ? via.verify : state.verify;
  if (typeof verify !== "function") return { ok: false, reason: "no_proof" };
  const softwareOk = via.softwareOk || state.softwareOk;
  /** @type {any} */ let r;
  try { r = await verify({ ...(request.chain ? { chain: request.chain } : {}), op: request.op, fields: request.fields, proof, moment, request: { op: request.op, fields: request.fields }, ...(via.dry === true ? { dry: true } : {}) }); } catch { return { ok: false, reason: "no_proof" }; }
  // only `null` means the proof stands (the sealing process's own answer); `undefined`, a bare boolean or anything else is a refusal
  if (r === null) return { ok: true };
  if (r === undefined) return { ok: false, reason: "no_proof" };
  if (typeof r === "string") return { ok: false, reason: yesReason(r) };
  if (r && typeof r === "object") {
    if (r.ok === true) {
      // a software key is a yes only where the build takes software keys
      // a result that does not say how strong the key was counts as software: refused unless this build takes software keys
      // the sealing process says `unattested` for a key it enrolled without a platform attestation (a sideloaded iPhone, an Android phone): a real device key, so it counts as real, never as software
      const strong = ["real", "hardware", "unattested", "enclave", "enclave, unattested", "passkey"].includes(String(r.strength)) || ["attested", "unattested"].includes(String(r.method));
      if (!strong && !(() => { try { return softwareOk() === true; } catch { return false; } })()) return { ok: false, reason: "software_key" };
      return { ok: true, strength: strong ? "real" : "software" };
    }
    return { ok: false, reason: yesReason(r.code || r.reason) };
  }
  return { ok: false, reason: "no_proof" };
}
