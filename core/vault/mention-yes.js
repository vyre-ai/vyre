// @ts-check
// mention-yes: the member's one yes at the tag. Tagging her own item in a chat lends it to that chat's agent, and the Switchboard (a module) makes the call, so the registry's presence floor does not ask her
// (it skips module callers). Her app signs a yes for op vault.me.mention.lend over { asker, id, thread, agent } (and origin when the tag names one) with her own device key; the Switchboard passes it through as
// input.yes and never makes one. The Vault checks it here with the one yes verifier (lib/one-yes.js yes(), through ctx.verifyYes): the key must be hers, the proof bound to exactly these fields, fresh, and spent
// once. No verifier, no yes, a replayed yes or a yes for anything else lends nothing: it fails closed.

export const OP = "vault.me.mention.lend";
const refused = (/** @type {string} */ why) => Object.assign(new Error(`Your yes is needed to lend this: ${why}`), { code: "presence_required" });

/** What her key signs: the call's own fields, nothing the Switchboard could add. @param {string} asker @param {any} input */
export const yesFields = (asker, input) => ({ asker, id: String(input.id), thread: String(input.thread), agent: String(input.agent), ...(input.origin ? { origin: String(input.origin) } : {}) });

/** @param {any} ctx @param {string} asker @param {any} input */
export async function requireYes(ctx, asker, input) {
  const verify = ctx && ctx.verifyYes;
  if (typeof verify !== "function") throw refused("this server cannot check one");
  if (typeof input.yes !== "string" || !input.yes || input.yes.length > 8000) throw refused("none came with the tag");
  /** @type {any} */ let proof = null;
  try { proof = JSON.parse(Buffer.from(input.yes, "base64url").toString("utf8")); } catch { /* not a proof */ }
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw refused("it was not a proof");
  const r = await verify(asker, OP, yesFields(asker, input), proof).catch(() => null);
  if (!r || r.ok !== true) throw refused(r && typeof r.reason === "string" ? r.reason : "it did not check");
}
