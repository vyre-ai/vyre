// @ts-check
// A switchboard account's credential value: a member's own key (vault.member.put) is released only for its owner's turn, only while they are a member, and only into this child's environment (G03);
// any other account's item comes from the vault as before.
/** @param {any} ctx @param {any} a the account row (its vault_item and person) @returns {Promise<string | null>} */
export async function keyValue(ctx, a) {
  const mk = /^member:(mk_[0-9a-f]{16})$/.exec(String(a.vault_item || ""));
  if (!mk) return ctx.vault ? ctx.vault.fetch(a.vault_item).catch(() => null) : null;
  const r = a.person ? await ctx.call("vault.member.release", { id: mk[1], person: String(a.person) }).catch(() => null) : null;
  if (!r || r.error || !r.data) throw Object.assign(new Error(`${a.label}'s key needs attention: ${r && r.error ? r.error.message : "it is not available to this account"}`), { code: "no_credential" });
  return r.data.value;
}
