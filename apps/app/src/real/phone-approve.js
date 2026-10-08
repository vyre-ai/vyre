// @ts-check
// The phone's side of "Approve on your phone" (platform's core/approvals): the pending asks as cards, what a card shows, and answering one by signing its payload hash with the person's
// device key behind Face ID. The key is native-core's iOS key module (signPresence); it is behind the `signer` argument here, so a test (and a phone without the module yet) uses a fake.

import { hashMatches, payloadHash } from "./payload-hash.js";

/** @typedef {{ id: string, title: string, body: string, op: string, space: string, fields: Record<string, any>, payload_hash: string, asked_from?: string, acted_via?: string, expires_in_s?: number }} Pending */
/** @typedef {{ op: string, space: string, fields: Record<string, any>, payload_hash: string, prompt: string, person: string }} SignRequest */
/** @typedef {{ signPresence(req: SignRequest): Promise<any>, signMany?(reqs: SignRequest[]): Promise<any[] | null> }} Signer */

/** The cards from approvals.pending, newest asks last as the box lists them. @param {any} answer @returns {Pending[]} */
export const cardsFrom = (answer) => (Array.isArray(answer?.approvals) ? answer.approvals.filter((/** @type {any} */ a) => a && typeof a.id === "string" && (typeof a.payload_hash === "string" || signOf(a))).map(normalize) : []);

/** A card made for a device's yes (wink-2: moment, request, line, sign { op, space, fields }): what the key signs is `sign`, verbatim. @param {any} c */
const signOf = (c) => (c && c.sign && typeof c.sign.op === "string" && typeof c.sign.space === "string" && c.sign.fields && typeof c.sign.fields === "object" ? /** @type {{ op: string, space: string, fields: Record<string, any> }} */ (c.sign) : null);

/** A device card is shown by the server's own line, signs its `sign` exactly, and has its hash computed here from that. @param {any} c @returns {Pending} */
function normalize(c) {
  const sg = signOf(c);
  if (!sg) return c;
  return { ...c, title: String(c.line || c.title || "A device is asking for your yes"), body: c.body || "Approving signs exactly this with the key on this phone. If you did not just ask for it, deny it.", op: sg.op, space: sg.space, fields: sg.fields, payload_hash: payloadHash(sg.op, sg.space, sg.fields) };
}

/** What the card shows as given: each field name and value, nothing summarised away, because those are what is being signed. @param {Pending} c */
export function factLines(c) {
  const out = [];
  for (const [k, v] of Object.entries(c.fields ?? {})) out.push(`${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return out;
}

/** The line under a card: where it was asked from and how long it lasts. @param {Pending} c */
export const askedLine = (c) => [c.asked_from ? `Asked from ${c.asked_from}` : "", c.acted_via === "assistant" ? "(Sent by Vyre Assistant)" : "", c.expires_in_s ? `ends in ${Math.max(1, Math.round(c.expires_in_s / 60))} min` : ""].filter(Boolean).join(", ");

/** The words for how an answer went. @param {string | undefined} code @param {string} [how] the method on this device (on-phone.js howWord): "fingerprint", "Face ID or Touch ID", "passkey" */
export function answerRefusal(code, how = "Face ID or Touch ID") {
  if (code === "ERR_CANCELED" || code === "cancelled") return "Cancelled. Nothing was approved.";
  if (code === "ERR_BIOMETRIC" || code === "ERR_NO_BIOMETRICS") return `${how.charAt(0).toUpperCase()}${how.slice(1)} did not work. Nothing was approved.`;
  if (code === "ERR_KEY_INVALIDATED") return `Your ${how} changed, so this phone's key must be set up again. Sign in to Vyre again.`;
  if (code === "no_signer") return "This phone cannot approve yet. Update Vyre.";
  if (code === "not_found") return "That request ended before you answered.";
  if (code === "no_person" || code === "ERR_NO_PERSON") return "This phone does not know who you are yet. Open Vyre and sign in, then try again.";
  if (code === "ERR_PAYLOAD_MISMATCH") return "This request does not match what it says. Nothing was approved. Ask again from the other device.";
  if (code === "hash_mismatch") return "This request does not match what it says. Nothing was approved. Ask again from the other device.";
  if (code === "needs_presence") return "That approval did not match what was asked. Nothing was approved.";
  return "The approval did not go through.";
}

/**
 * Approve one card: Face ID signs its payload hash, and the signed proof goes beside approvals.answer (never inside the input). `call` carries `{ kernelProof }`.
 * @param {Pending} card @param {Signer | null} signer
 * @param {(tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => Promise<any>} call
 * @param {(proof: unknown) => string} header base64url JSON for x-vyre-kernel-proof
 * @param {string} person this phone's person id: the key module builds the proof's chain hash from it
 */
export async function approveCard(card, signer, call, header, person = "") {
  if (!person) throw Object.assign(new Error("no person id"), { code: "no_person" });
  if (!signer) throw Object.assign(new Error("no signer"), { code: "no_signer" });
  // Never sign a hash the box gave without recomputing it from the fields this card shows (AP-1): a mismatch is refused before Face ID is asked.
  if (!hashMatches(card)) throw Object.assign(new Error("the hash does not match what the card shows"), { code: "hash_mismatch" });
  const proof = await signer.signPresence({ op: card.op, space: card.space, fields: card.fields, payload_hash: card.payload_hash, prompt: card.title, person });
  if (!proof || proof.payload_hash !== card.payload_hash) throw Object.assign(new Error("the signed proof is not for this card"), { code: "needs_presence" });
  return call("approvals.answer", { id: card.id, approve: true }, { kernelProof: header(proof) });
}

/** Say no: only the person's own session ends it; nothing is signed. @param {Pending} card @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call */
export const refuseCard = (card, call) => call("approvals.answer", { id: card.id, approve: false });
