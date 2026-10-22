// @ts-check
// The account a limited turn moves to when no routing list names a next entry: the asker's next
// signed-in account on another provider. The list is already only accounts that serve that person.

/**
 * The next signed-in account after the provider that just stopped, walking the list past the
 * current provider and then from the top. Same provider is never the automatic next (two accounts
 * of one provider are a routing list the person saves on purpose). Null when nothing else is signed in.
 * @param {any[]} rows signed-in accounts, in list order
 * @param {{ provider?: string, account?: string|null, tried?: string[] }} [cur]
 * @returns {{ provider: string, account: string|null } | null}
 */
export function nextSignedAccount(rows, cur = {}) {
  const provider = String(cur.provider || "claude");
  const skip = new Set((cur.tried || []).map(String));
  skip.add(`${provider}:${cur.account || ""}`);
  /** @type {string[]} */ const order = [];
  for (const a of rows || []) if (a && a.provider && !order.includes(a.provider)) order.push(a.provider);
  const at = order.indexOf(provider);
  const rotated = at < 0 ? order : [...order.slice(at + 1), ...order.slice(0, at)];
  for (const p of rotated) {
    if (p === provider) continue;
    const hit = (rows || []).find(a => a && a.provider === p && !a.pending && !skip.has(`${a.provider}:${a.id || ""}`) && !skip.has(`${a.provider}:`));
    if (!hit) continue;
    return { provider: hit.provider, account: hit.synthetic || hit.id === "default" ? null : hit.id };
  }
  return null;
}
