// @ts-check
// The owner's phone side of "a device asks for my yes" (wink-2, work/wink-session 9eba9d155, ruling c328cd1): a browser with no key it can sign with asks the owner's phone for the yes one of three moments
// needs (pair a device, a vault secret, an outward send). presence.person.session-pending gives { asks: [{ id, device, line, moment, request: { op, fields }, asked_at }] }, newest first; `line` is made by
// the server, never the asker's words. The phone shows the line and the exact fields, and Allow signs the request with the hardware key (signPresence, Face ID) and sends presence.person.session-answer
// { id, yes, proof }. Don't allow sends { id, yes: false } (the asker then waits 10 minutes). The event presence.session-asked only says a new ask exists: the phone reads the list. Pure: Node tests it.
import { answerRefusal, factLines } from "./phone-approve.js";
import { payloadHash } from "./payload-hash.js";

export const SESSION_ASKED = "presence.session-asked";
export const SESSION_ANSWER = "presence.person.session-answer";
export const SESSION_PENDING = "presence.person.session-pending";
export const ASK_LIFE_MS = 5 * 60_000;

/** @typedef {{ id: string, device: string, line: string, moment: string, request: { op: string, fields: Record<string, any> }, at: number }} SessionAsk */

/** The line the person reads, from the server: printable, short. @param {unknown} s */
const lineOf = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);

/** The list after the pending answer: each ask kept once, from the server's own row; asks gone from the answer are dropped (answered, expired or taken by another phone). @param {SessionAsk[]} list @param {any} answer @param {number} now @returns {SessionAsk[]} */
export function withPending(list, answer, now) {
  const rows = Array.isArray(answer) ? answer : Array.isArray(answer?.asks) ? answer.asks : [];
  /** @type {SessionAsk[]} */ const out = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !r.id || out.some((a) => a.id === r.id)) continue;
    if (!r.request || typeof r.request.op !== "string") continue;
    const kept = list.find((a) => a.id === r.id);
    out.push({ id: r.id, device: String(r.device ?? ""), line: lineOf(r.line) || "A device is asking for your yes", moment: String(r.moment ?? ""), request: { op: r.request.op, fields: r.request.fields && typeof r.request.fields === "object" ? r.request.fields : {} }, at: kept?.at ?? now });
  }
  return out.filter((a) => now - a.at < ASK_LIFE_MS);
}

/** @param {SessionAsk} a */
export const askTitle = (a) => a.line;
/** The exact fields the yes signs, as given. @param {SessionAsk} a */
export const askFacts = (a) => factLines(/** @type {any} */ ({ fields: a.request.fields }));
export const ASK_BODY = "Allowing signs exactly this with your Face ID. If you did not just ask for it, choose Don't allow.";
export const ALLOW = "Allow";
export const DONT_ALLOW = "Don't allow";
export const allowedToast = "Allowed.";
export const refusedToast = "Not allowed. Nothing changed.";

/**
 * Answer one ask. A yes is signed over exactly the request on the card; the proof must be for that payload before it is sent.
 * @param {SessionAsk} a @param {boolean} yes
 * @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call
 * @param {{ signer: { signPresence(req: any): Promise<any> } | null, person: string, space: string }} [o]
 */
export async function answerSession(a, yes, call, o) {
  if (!yes) { await call(SESSION_ANSWER, { id: a.id, yes: false }); return refusedToast; }
  if (!o || !o.person) throw Object.assign(new Error("no person id"), { code: "no_person" });
  if (!o.signer) throw Object.assign(new Error("no signer"), { code: "no_signer" });
  const payload_hash = payloadHash(a.request.op, o.space, a.request.fields);
  const proof = await o.signer.signPresence({ op: a.request.op, space: o.space, fields: a.request.fields, payload_hash, prompt: a.line, person: o.person });
  if (!proof || proof.payload_hash !== payload_hash) throw Object.assign(new Error("the signed proof is not for this card"), { code: "needs_presence" });
  await call(SESSION_ANSWER, { id: a.id, yes: true, proof });
  return allowedToast;
}

/** The words for a failed answer. @param {string | undefined} code */
export function sessionRefusal(code) {
  if (code === "software_key") return "Approve this with the key in your phone. A software key cannot say yes here.";
  if (code === "wrong_request" || code === "bad_input") return "That did not match what was asked. Nothing was allowed.";
  if (code === "unknown_key") return "This phone's key is not set up for this yet. Sign in to Vyre again.";
  if (code === "expired" || code === "none" || code === "not_found") return "That request ended before you answered.";
  if (code === "denied") return "Only your phone can answer this.";
  if (code === "replayed") return "That yes was already used. Ask again.";
  if (code === "presence_required" || code === "needs_presence") return "That needs your Face ID. Nothing was allowed.";
  return answerRefusal(code);
}
