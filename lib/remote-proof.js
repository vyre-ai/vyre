// @ts-check
// The person's presence proof for ONE call that crosses to a space's home on a paired server. The tool that handles the call (core/records-tools via the gateway door) runs the remote gateway inside `withProof`,
// and the remote kernel's signer (core/daemon) reads it back when the home answers needs_presence with a challenge. The proof is only ever the one the person made for this call; nothing is kept, and the home
// still checks its key, role and hash itself. A call with no proof stays refused.
import { AsyncLocalStorage } from "node:async_hooks";

/** @type {AsyncLocalStorage<{ presence: any }>} */
const store = new AsyncLocalStorage();

/** Run `fn` with this proof ({ presence } as ctx.kernel.proofFrom answers it, or {}). @template T @param {any} proof @param {() => T} fn @returns {T} */
export function withProof(proof, fn) {
  return store.run({ presence: proof && typeof proof === "object" && proof.presence !== undefined ? proof.presence : undefined }, fn);
}

/** The remote kernel's presence signer: answers the home's challenge with the proof the caller made for this call. @returns {Promise<{ presence: any }>} */
export async function proofSigner() {
  const s = store.getStore();
  if (!s || s.presence === undefined) throw Object.assign(new Error("no proof for this call (ask the person to approve it on their device)"), { code: "needs_presence" });
  return { presence: s.presence };
}
