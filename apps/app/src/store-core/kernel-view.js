// @ts-check
// deck/ui/kernel-view: small pure readers over the kernel's shapes (kernel/contracts), shared by the screens, so no screen picks a record, a task or an event
// apart in its own way. No DOM, no store, no clock.
import { parseUrn } from "./mock-ids.js";

/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").GatewayRecord} GatewayRecord */
/** @typedef {import("./contracts.js").TypeDefinition} TypeDefinition */
/** @typedef {import("./contracts.js").FieldDefinition} FieldDefinition */
/** @typedef {import("./contracts.js").EventEnvelope} EventEnvelope */

/** The id of an actor, of a role-or-actor checker, or of a plain id. A role checker has no id (it is not a person yet). @param {Actor|{ role: string }|string|null|undefined} x @returns {string} */
export function aid(x) {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  return "id" in x ? String(x.id) : "";
}

/** Is this checker a role that is not yet resolved to a person? @param {any} c */
export const isRole = c => !!c && typeof c === "object" && "role" in c && !("id" in c);

/** @param {TypeDefinition} def @param {string} name @returns {FieldDefinition | undefined} */
export const fieldOf = (def, name) => def.fields.find(f => f.name === name);

/** The stage names of a type: the stage field's options, else the type's stages. @param {TypeDefinition} def @param {FieldDefinition} [f] @returns {string[]} */
export function stageNames(def, f) {
  const field = f || def.fields.find(x => x.kind === "stage");
  if (field?.options?.length) return [...field.options];
  return (def.stages || []).map(s => s.name);
}

/** The first stage field of a type. @param {TypeDefinition} def */
export const stageFieldOf = def => def.fields.find(f => f.kind === "stage");

/** A record's value for one field. @param {GatewayRecord} rec @param {string} name */
export const val = (rec, name) => rec.data?.[name];

/** The space a urn belongs to. @param {string} urn */
export const spaceOfUrn = urn => parseUrn(urn)?.space || "";

/** The record or task id inside a urn, for a route and a key. @param {string} urn */
export const idOfUrn = urn => parseUrn(urn)?.id || "";

/** The actor of an event, as the id inside "<kind>:<id>@<space>". @param {EventEnvelope} e */
export function eventActor(e) {
  const m = /^[a-z]+:([^@]+)@/.exec(e.actor || "");
  return m ? m[1] : "";
}

/**
 * What the Deck prints for an event. The kernel's envelope carries a type, a subject and data, not a sentence; the sentence is the Deck's own (data.what and data.why
 * in the mock, until a gateway defines where card text comes from).
 * @param {EventEnvelope} e @returns {{ id: string, actor: string, what: string, why?: string, at: number, record?: string, task?: string }}
 */
export function eventLine(e) {
  const d = /** @type {any} */ (e.data || {});
  return { id: e.id, actor: eventActor(e), what: String(d.what ?? e.type), why: d.why, at: e.time, record: d.record ?? (e.subject && parseUrn(e.subject)?.type !== "task" ? e.subject : undefined),
    task: d.task ?? (parseUrn(e.subject)?.type === "task" ? parseUrn(e.subject)?.id : undefined) };
}

/** True for the states a finished task is in. @param {Task} t */
export const finished = t => t.state === "done" || t.state === "skipped";

/** How long a revealed value stays on screen (and how long the kernel's reveal result is good for). */
export const REVEAL_MS = 30_000;

/** What a signer is called to a person. @type {Record<string, string>} */
const SIGNER_WORDS = { secure_enclave: "Face ID", windows_hello: "Windows Hello", tpm: "your device's key", strongbox: "your phone's key", webauthn_platform: "a passkey" };
/** "Face ID", "a passkey": how a presence proof reads in the timeline. @param {import("./contracts.js").PresenceProof} proof */
export const signerWords = proof => SIGNER_WORDS[proof?.signer] || "your device";

/**
 * A PresenceProof of the kernel's shape, made by the preview: there is no hardware key here, so nothing is signed, and the mock store only checks the shape.
 * The real signer (the phone's biometric, WebAuthn, the Secure Enclave) replaces this one function. @param {{ decision: string, payload_hash?: string, now?: number }} o @returns {import("./contracts.js").PresenceProof}
 */
export function simulatedProof({ decision, payload_hash = "preview", now = Date.now() }) {
  return { signer: "secure_enclave", key_id: "preview-key", payload_hash, decision, chain_hash: "preview", issued_at: now, expires_at: now + 60_000, nonce: `preview-${now}`, signature: "preview" };
}
