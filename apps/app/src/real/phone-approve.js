// @ts-check
// The phone's side of "Approve on your phone" (platform's core/approvals): the pending asks as cards, what a card shows, and answering one by signing its payload hash with the person's
// device key behind Face ID. The key is native-core's iOS key module (signPresence); it is behind the `signer` argument here, so a test (and a phone without the module yet) uses a fake.

import { hashMatches } from "./payload-hash.js";

/** @typedef {{ id: string, title: string, body: string, op: string, space: string, fields: Record<string, any>, payload_hash: string, asked_from?: string, expires_in_s?: number }} Pending */
/** @typedef {{ signPresence(req: { op: string, space: string, fields: Record<string, any>, payload_hash: string, prompt: string }): Promise<any> }} Signer */

/** The cards from approvals.pending, newest asks last as the box lists them. @param {any} answer @returns {Pending[]} */
export const cardsFrom = (answer) => (Array.isArray(answer?.approvals) ? answer.approvals.filter((/** @type {any} */ a) => a && typeof a.id === "string" && typeof a.payload_hash === "string") : []);

/** What the card shows as given: each field name and value, nothing summarised away, because those are what is being signed. @param {Pending} c */
export function factLines(c) {
  const out = [];
  for (const [k, v] of Object.entries(c.fields ?? {})) out.push(`${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return out;
}

/** The line under a card: where it was asked from and how long it lasts. @param {Pending} c */
export const askedLine = (c) => [c.asked_from ? `Asked from ${c.asked_from}` : "", c.expires_in_s ? `ends in ${Math.max(1, Math.round(c.expires_in_s / 60))} min` : ""].filter(Boolean).join(", ");

/** The words for how an answer went. @param {string | undefined} code */
export function answerRefusal(code) {
  if (code === "ERR_CANCELED" || code === "cancelled") return "Cancelled. Nothing was approved.";
  if (code === "ERR_BIOMETRIC" || code === "ERR_NO_BIOMETRICS") return "Face ID did not work. Nothing was approved.";
  if (code === "ERR_KEY_INVALIDATED") return "Your Face ID changed, so this phone's key must be set up again. Sign in to Vyre again.";
  if (code === "no_signer") return "This phone cannot approve yet. Update Vyre.";
  if (code === "not_found") return "That request ended before you answered.";
  if (code === "hash_mismatch") return "This request does not match what it says. Nothing was approved. Ask again from the other device.";
  if (code === "needs_presence") return "That approval did not match what was asked. Nothing was approved.";
  return "The approval did not go through.";
}

/**
 * Approve one card: Face ID signs its payload hash, and the signed proof goes beside approvals.answer (never inside the input). `call` carries `{ kernelProof }`.
 * @param {Pending} card @param {Signer | null} signer
 * @param {(tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => Promise<any>} call
 * @param {(proof: unknown) => string} header base64url JSON for x-vyre-kernel-proof
 */
export async function approveCard(card, signer, call, header) {
  if (!signer) throw Object.assign(new Error("no signer"), { code: "no_signer" });
  // Never sign a hash the box gave without recomputing it from the fields this card shows (AP-1): a mismatch is refused before Face ID is asked.
  if (!hashMatches(card)) throw Object.assign(new Error("the hash does not match what the card shows"), { code: "hash_mismatch" });
  const proof = await signer.signPresence({ op: card.op, space: card.space, fields: card.fields, payload_hash: card.payload_hash, prompt: card.title });
  if (!proof || proof.payload_hash !== card.payload_hash) throw Object.assign(new Error("the signed proof is not for this card"), { code: "needs_presence" });
  return call("approvals.answer", { id: card.id, approve: true }, { kernelProof: header(proof) });
}

/** Say no: only the person's own session ends it; nothing is signed. @param {Pending} card @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call */
export const refuseCard = (card, call) => call("approvals.answer", { id: card.id, approve: false });
