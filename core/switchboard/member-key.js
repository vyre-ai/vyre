// @ts-check
// member-key: the key or token of a person's own AI account (a member's setup token or API key), for the one turn that is theirs. It is never read from the home's vault: it would be the owner's item, used in a
// member's turn. A key not kept in its owner's own vault is refused outright; one that is kept there is lent by the Vault for this turn only (the Vault finds the person from the turn's verified chain, and
// refuses an account that is not theirs or a locked vault), and the value goes to the caller alone. Anything short of a value is a refusal, never a fall back to another vault.
// The Switchboard's own call carries no proof of a person, so the lend goes through the daemon's lendKey (needs.daemon, core/daemon/lend-key.js), which opens the ASKER's one-turn session itself and ends it.
// `turn` is what lend-turn.js settled before asking: the verified asker of this turn, still in the chat, and the account that same person's. Without it (no daemon, no asker) nothing is lent.

import { mayReadHomeVault } from "../../lib/account-source.js";
export { lendTurn } from "./lend-turn.js";

const refuse = (/** @type {string} */ message, code = "denied") => Object.assign(new Error(message), { code });

/** @param {{ lendKey?: ((q: { asker: string, account: string, space?: string | null }) => Promise<any>) | null }} ctx @param {any} a an account row with a person and a key or token kind @param {{ asker: string, space?: string | null } | (() => Promise<{ asker: string, space?: string | null }>) | null | undefined} turn (settled lazily: only an account that holds a key asks who may be lent it) @returns {Promise<string>} */
export async function memberKey(ctx, a, turn) {
  if (!mayReadHomeVault(a) || !a.own_vault) throw refuse(`${a.label} is not kept in its owner's own vault, so no turn can use it. Add it again from the account's owner.`);
  const settled = typeof turn === "function" ? await turn() : turn;
  const lent = settled && settled.asker && typeof ctx.lendKey === "function" ? await ctx.lendKey({ asker: String(settled.asker), account: String(a.id), space: settled.space || null }) : { error: { code: "denied", message: "no asker" } };
  if (lent.error) throw refuse(lent.error.code === "locked" ? `unlock your own vault to use ${a.label}` : `${a.label} is not available to this turn: it is a key of one person, used only in their own turns. Start the chat as that person, or choose an account of your own`, "no_credential");
  const v = lent.data && lent.data.value;
  if (typeof v !== "string" || !v) throw refuse(`${a.label} gave no key to this turn: ask its owner to add the key to their vault again`, "no_credential");
  return v;
}
