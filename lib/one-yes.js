// @ts-check
// One yes (DESIGN-one-yes.md, ruling c328cd1): the whole permission layer is two questions, asked in one place.
//   isYou(subject)  Is this call YOU (a verified person surface: a paired device, the terminal, the Capsule, the app)? A kernel chain is you only when it is exactly one person; a call (its meta) is you
//                   when lib/caller's verified person check says so. An agent, a model, a module, a guest is never you.
//   yes(moment, request, proof)  Is there a fresh yes from one of your REAL devices (Secure Enclave, Android keystore, passkey, Touch ID) over this exact request, for one of the three moments (pairing a
//                   new device, a vault secret, an outward send/post/pay)? { ok: true } or { ok: false, reason } with reason one of YES_REASONS. A software key is a yes only where the build takes software keys
//                   (a development build); on a release build it answers software_key.
// The verifier is the sealing process's one proof check (kernel/seal), given once by the daemon with `configureYes`; with none configured every yes is refused (no_proof): it fails closed.
import { isPerson } from "./caller.js";
import { MOMENT_OPS, REUSE_OPS, REUSE_MS } from "./one-yes-ops.js";
export { MOMENT_OPS, REUSE_OPS, REUSE_MS };
import { signOf } from "./one-yes-sign.js";
import { holdFields } from "./hold-fields.js";

export { signOf };

/** The three moments a yes is asked at (the user's standing rule). */
export const MOMENTS = Object.freeze(["pair", "vault", "outward"]);
/** Why a yes was refused. */
export const YES_REASONS = Object.freeze(["no_proof", "expired", "replayed", "wrong_request", "software_key", "unknown_key"]);

/** The card store's redeemer, set by the presence module: a card the owner's phone approved (its proof already verified when it was given) is spent ONCE by the asking device's act. @type {null | ((id: string, moment: string, request: { op: string, fields: any }, device: string | null) => "ok" | "ok_reuse" | "replayed" | "wrong_request" | "no_proof")} */
/** One redeemer per approvals queue in this process (a daemon has one; a test that starts two daemons has two): a card belongs to the queue that holds it. */
const redeemers = new Set();
/** Cards admitted at the edge for a 0.3.0 client's old header (the registry checked that header, then admits one card for exactly that call and redeems it at once through yes()). Single use, a minute. Deleted with the adapter in 0.3.2. */
const admitted = new Map();
const ADMIT_MS = 60_000;
const canonFields = (/** @type {any} */ o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
/** @param {{ moment: string, op: string, fields: Record<string, any>, device: string }} a @returns {string} the card id */
export function admitCard(a) {
  const t = Date.now();
  for (const [k, v] of admitted) if (v.until <= t) admitted.delete(k);
  const id = `adm_${Math.random().toString(36).slice(2)}${t.toString(36)}`;
  admitted.set(id, { ...a, until: t + ADMIT_MS });
  return id;
}
const redeemAdmitted = (/** @type {string} */ id, /** @type {string} */ moment, /** @type {any} */ request, /** @type {string|null} */ device) => {
  const a = admitted.get(id);
  if (!a || a.until <= Date.now()) { admitted.delete(id); return null; }
  admitted.delete(id);
  return a.moment === moment && a.op === request.op && canonFields(a.fields) === canonFields(request.fields) && a.device === device ? "ok" : "wrong_request";
};
const redeemCard = (id, moment, request, device) => { const mine = redeemAdmitted(id, moment, request, device); if (mine) return mine; let last = "no_proof"; for (const fn of redeemers) { const r = fn(id, moment, request, device); if (r !== "no_proof") return r; last = r; } return last; };
/** Tools that send as you but are not marked `outward` in a module.json because the person's own approval of a held item is the send itself (the Gate's approve, a send from the Capsule). */
export const NAMED_OUTWARD = Object.freeze(["gate.approve", "apps.send", "hands.commit"]);
/** Moment tools where an agent's call is a REQUEST, not an act: the tool records it as pending for a person (the vault's grants and passes, the vault.pending list), so the floor lets an agent's call reach the tool and asks the yes of the person who approves it. */
export const AGENT_PENDS = Object.freeze(["vault.grant", "vault.agent.grant", "vault.pass.create", "vault.pass.accept"]);
/** @typedef {(op: string) => boolean} OutwardCheck */
/** Is this op one the moment covers? @param {string} moment @param {string} op @param {OutwardCheck} [isOutward] the registry's flag read (ctx.modules.isOutward) */
export const opFitsMoment = (moment, op, isOutward) => (moment === "pair" || moment === "vault" ? MOMENT_OPS[moment].includes(String(op)) : moment === "outward" ? outwardOf(isOutward, op) : false);
/** @param {OutwardCheck | undefined} fn @param {string} op */
const outwardOf = (fn, op) => { try { return NAMED_OUTWARD.includes(String(op)) || typeof fn === "function" && /^[a-z][a-z0-9-]*\.[a-z0-9.-]{1,80}$/.test(String(op)) && fn(String(op)) === true; } catch { return false; } };
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
  // a digest is not words: it is how the call is bound, never what the person reads (and a 32-character digest would make a title look like a secret)
  const q = (/** @type {unknown} */ v, /** @type {string} */ fallback) => (v ? `"${String(v).slice(0, 60)}"` : fallback);
  const f = Object.entries(fields || {}).filter(([k]) => !/sha256|digest|hash/i.test(k)).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(", ");
  const toPart = fields && fields.to ? ` to ${q(fields.to, "someone")}` : "";
  /** @type {Record<string, string>} */
  const WHAT = {
    "vault.reveal": `show ${name} from your vault`, "vault.copy": `copy ${name} from your vault`, "vault.totp": `get the sign-in code for ${name}`,
    "vault.inject": `use ${name} from your vault in a command`, "vault.resolve": `use ${name} from your vault`, "vault.render": `fill in a file with ${name} from your vault`, "memory.identity.unlock": "let your assistant read your private memory for a few minutes",
    "presence.enroll": "add a new key for you on this server", "link.pair.approve": "pair another machine with this one",
    "wink.phone.pair.answer": "pair a new phone", "wink.server.pair.answer": "pair this server to a new device", "wink.pair.server": "pair a server",
    "wink.phone.open": "show a code to add a phone", "wink.code.ack": "add the device whose code you typed", "wink.code.open": "show a code to add a computer or a server", "records.seal-put": "put a value into a sealed field", "records.reveal": "show a sealed value", "relay.pair.start": "start adding a device", "relay.enable": "turn on the relay for this server",
    "vault.members.invite": `invite ${q(fields && fields.person, "someone")} into ${q(fields && fields.vault, "a shared vault")}`,
    "vault.members.role": `make ${q(fields && fields.person, "a member")} ${fields && fields.role ? String(fields.role).slice(0, 20) : "something else"} in ${q(fields && fields.vault, "a shared vault")}`,
    "vault.members.remove": `remove ${q(fields && fields.person, "a member")} from ${q(fields && fields.vault, "a shared vault")} and change its key`,
    "vault.vaults.rotate": `change the key of ${q(fields && fields.vault, "a shared vault")}`,
    // what an assistant's outward call does, in words: never the tool's name and never the words of the message
    "mail.send": `send an email${toPart}${fields && fields.subject ? ` about ${q(fields.subject, "")}` : ""}`,
    "google.mail.send": `send an email${toPart}${fields && fields.subject ? ` about ${q(fields.subject, "")}` : ""}`,
    "comms.send": `send a message${toPart}`,
    "documents.send": `send ${q(fields && (fields.name || fields.title), "a document")}${toPart}`,
    "documents.send-signed": `send ${q(fields && (fields.name || fields.title), "a document")}${toPart} to sign`,
    "mcp.call": "use a connected tool outside Vyre",
    "spaces.invites.create": "invite someone into a Space",
    "artifacts.share": "make a public link to an artifact", "artifacts.public.set": "make an artifact public",
    "files.drive.share": "share a file from your Drive", "files.drive.upload": "put a file in your Drive", "files.deliver": "send a file out of Vyre",
    "github.project.pr.open": "open a pull request on GitHub", "github.project.pr.merge": "merge a pull request on GitHub", "github.project.pr.review": "review a pull request on GitHub", "github.session.push": "push code to GitHub", "github.session.pr": "open a pull request on GitHub", "github.repo.create": "create a repository on GitHub",
    "google.calendar.create": "add an event to your Google calendar", "google.calendar.update": "change an event on your Google calendar",
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

/**
 * The fields a yes for this call is bound to: the plain fields of the input when ALL of it is plain, else the plain short fields plus a digest of the whole input (hold-fields.js), so a call that carries a
 * list or a long text (a vault import) is covered whole by one yes and nothing in it can change after. @param {any} input @returns {Record<string, string | number | boolean>}
 */
export function yesFieldsOf(input) { return plainFieldsOf(input) || holdFields(input); }

/** Register this queue's redeemer; answers the function that takes it away again. @param {any} fn (id, moment, request, device) => "ok" | "ok_reuse" | "replayed" | "wrong_request" | "no_proof"; null takes every redeemer away (a test) */
export function setCardRedeemer(fn) { if (typeof fn !== "function") { redeemers.clear(); return () => {}; } redeemers.add(fn); return () => { redeemers.delete(fn); }; }

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
 * @returns {Promise<{ ok: true, strength?: string, reuse?: boolean } | { ok: false, reason: string }>}
 */
export async function yes(moment, request, proof, via = {}) {
  if (!MOMENTS.includes(/** @type {any} */ (moment))) return { ok: false, reason: "wrong_request" };
  if (!request || typeof request !== "object" || typeof request.op !== "string" || !/^[a-z][a-z0-9_.-]{1,80}$/.test(request.op) || !request.fields || typeof request.fields !== "object" || Array.isArray(request.fields)) return { ok: false, reason: "wrong_request" };
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return { ok: false, reason: "no_proof" };
  // a card the owner's phone already approved: its proof was checked (and spent) when the phone gave it; the asking device's act spends the card, once, for exactly that request
  if (typeof proof.card === "string") {
    // the asking device is mandatory and comes from the verified call (never from the client): a redeem that names no device spends nothing
    const device = typeof request.device === "string" && request.device ? request.device : null;
    const r = device ? redeemCard(proof.card, moment, { op: request.op, fields: request.fields }, device) : "no_proof";
    return r === "ok" || r === "ok_reuse" ? { ok: true, strength: "real", ...(r === "ok_reuse" ? { reuse: true } : {}) } : { ok: false, reason: r };
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

// ---- the reuse window (ruling 9 Oct): one yes for a reveal may cover the next ones for five minutes ----------------------------------------------------------------------------------
/** The only tools a reuse window covers: showing, copying or computing a code for a secret you already asked to see. */
/**
 * A short window bound to ONE device and ONE person: opened by a yes that asked for it, valid for REUSE_OPS only, never for an agent, gone when it ends or the process restarts. No second mechanism:
 * a window is only ever opened from inside a successful yes().
 * @param {() => number} [now]
 */
export function createReuse(now = Date.now) {
  /** @type {Map<string, number>} */ const open = new Map();
  const key = (/** @type {string} */ device, /** @type {string} */ person) => `${person}\n${device}`;
  return {
    /** @param {string} device @param {string} person */
    grant(device, person) { if (device && person) open.set(key(device, person), now() + REUSE_MS); for (const [k, t] of open) if (t <= now()) open.delete(k); },
    /** Is there a window for this device and person that covers this tool? @param {string} device @param {string} person @param {string} tool */
    ok(device, person, tool) { const t = open.get(key(device, person)); return Boolean(t && t > now() && REUSE_OPS.includes(tool)); },
    clear() { open.clear(); },
  };
}
