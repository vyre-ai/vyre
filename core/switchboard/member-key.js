// @ts-check
// member-key: the key or token of a person's own AI account (a member's setup token or API key), for the one turn that is theirs. It is never read from the home's vault: it would be the owner's item, used in a
// member's turn. A key not kept in its owner's own vault is refused outright; one that is kept there is lent by the Vault for this turn only (the Vault finds the person from the turn's verified chain, and
// refuses an account that is not theirs or a locked vault), and the value goes to the caller alone. Anything short of a value is a refusal, never a fall back to another vault.

import { mayReadHomeVault } from "../../lib/account-source.js";

const refuse = (/** @type {string} */ message, code = "denied") => Object.assign(new Error(message), { code });

/** @param {{ call: (tool: string, input: any, opts?: { relay?: boolean }) => Promise<any> }} ctx @param {any} a an account row with a person and a key or token kind @returns {Promise<string>} */
export async function memberKey(ctx, a) {
  if (!mayReadHomeVault(a) || !a.own_vault) throw refuse(`${a.label} is not kept in its owner's own vault, so no turn can use it. Add it again from the account's owner.`);
  // relayed: the Vault finds the person from the running turn's verified chain, which a plain module call does not carry (core/modules/relay-allowed.js lists exactly this call for the chat module)
  const lent = await ctx.call("vault.me.lend", { account: String(a.id) }, { relay: true });
  if (lent.error) throw refuse(lent.error.code === "locked" ? `unlock your own vault to use ${a.label}` : `${a.label} is not available to this turn: it is a key of one person, used only in their own turns. Start the chat as that person, or choose an account of your own`, "no_credential");
  const v = lent.data && lent.data.value;
  if (typeof v !== "string" || !v) throw refuse(`${a.label} gave no key to this turn: ask its owner to add the key to their vault again`, "no_credential");
  return v;
}
