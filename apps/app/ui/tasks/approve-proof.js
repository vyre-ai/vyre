// @ts-check
// The approver's yes for a task that waits for a check, signed over exactly what the kernel will check. The kernel hands the op, the fields (the task, its payload hash, the decision, and the review result's hash once the
// work was reviewed) and their hash with the task (`sign`); this recomputes the hash from the fields shown, refuses a mismatch, and signs. It rebuilds nothing, so a change in what the kernel binds does not need a change here.
import { hashMatches } from "../../src/real/payload-hash.js";

/**
 * @param {{ task: any, readTask: (id: string) => Promise<any>, signer: { signPresence(req: any): Promise<any> } | null, person: string }} o
 * @returns {Promise<any>} the PresenceProof for tasks.decide
 */
export async function signTaskApproval({ task, readTask, signer, person }) {
  const fresh = await readTask(task.id);
  const sign = fresh && fresh.state === "needs_check" ? fresh.sign : null;
  if (!sign || typeof sign.op !== "string" || !sign.fields || typeof sign.space !== "string") throw Object.assign(new Error("This task is not waiting for your yes any more. Open it again."), { code: "bad_state" });
  if (!hashMatches(sign)) throw Object.assign(new Error("This request does not match what it says. Nothing was approved."), { code: "needs_presence" });
  if (!signer) throw Object.assign(new Error("This phone cannot give the yes yet. Update Vyre."), { code: "no_signer" });
  const proof = await signer.signPresence({ op: sign.op, space: sign.space, fields: sign.fields, payload_hash: sign.payload_hash, prompt: `Approve: ${String(task.title || "this task").slice(0, 80)}`, person });
  if (!proof || proof.payload_hash !== sign.payload_hash) throw Object.assign(new Error("The signed yes is not for this request. Nothing was approved."), { code: "needs_presence" });
  return proof;
}
