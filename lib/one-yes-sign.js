// @ts-check
// What a person's key signs for a yes moment: one function and no imports, so the server's verifier (lib/one-yes.js) and the phone (apps/app) use the same file and neither drags the other's code in.

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
