// @ts-check
// What a member lent to the chat's agent for one turn (tagging her own login or connection, vault.me.mention.lend) ends when that turn ends, however it ends: it finishes, fails, is cancelled or
// stopped, or the thread goes. The Switchboard calls the vault for the person whose turn it was. A short expiry on the vault's side is only the backstop for a crash. A call that fails changes
// nothing here: the lend still lapses by its expiry, and nothing is thrown into the turn's own ending.

/**
 * @param {{ deps: { call: (tool: string, input: any) => Promise<any> } }} sb the Switchboard
 * @param {string} thread @param {string | null | undefined} asker the person whose turn it was (a per_ id)
 */
export function endLends(sb, thread, asker) {
  if (!asker || typeof asker !== "string") return;
  try { void Promise.resolve(sb.deps.call("vault.me.mention.end", { asker, thread })).catch(() => null); } catch { /* the expiry is the backstop */ }
}
