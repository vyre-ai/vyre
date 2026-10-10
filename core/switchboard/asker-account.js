// @ts-check
// A shared chat's turn runs on the ASKER's own account of the thread's provider (0.3.3 G04). Accounts belong to people (sessions_accounts.person; Accounts.resolve({ provider, person }) considers only the accounts
// that serve that person), so when the person who asks is not the one whose account the thread is on, the turn is one turn on THEIR account: the same one-turn path an @ account chip takes, with the
// conversation handed over, and the thread goes back to its own afterwards. A person with no account of their own for this provider keeps the thread's (their turn is not refused: a Space whose members
// have no sign-in of their own runs as it always did).

/**
 * @param {any} sb the Switchboard @param {string} id the thread @param {{ asker: string }} kernelTurn
 * @returns {Promise<{ provider: string, account: string, person: string } | null>} the one-turn target, or null when the thread's own account is the asker's (or the asker has none)
 */
export async function askerOver(sb, id, kernelTurn) {
  const rec = sb.record(id);
  if (!rec || !kernelTurn || !kernelTurn.asker) return null;
  const provider = rec.provider || "claude";
  const mine = await sb.accountFor({ provider, person: kernelTurn.asker, project: rec.project, agent: rec.agent }).catch(() => null);
  if (!mine || !mine.id || mine.id === rec.account) return null;
  return { provider, account: String(mine.id), person: kernelTurn.asker };
}
