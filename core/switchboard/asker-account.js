// @ts-check
// A shared chat's turn runs on the ASKER's own account of the thread's provider (0.3.3 G04). Accounts belong to people (sessions_accounts.person; Accounts.resolve({ provider, person }) considers only the
// accounts that serve that person), so a turn is never run on another member's sign-in:
//   - the asker has an own account for the provider: the turn runs on it (one turn, the conversation handed over, then the thread goes back to its own);
//   - none, and the thread's account serves them (the home's, or theirs, or no named account at all): the thread's account is theirs to use, nothing moves;
//   - none, and the thread's account is ANOTHER member's: the home's own default account for the provider if there is one, else the turn is refused in plain words ("add your own sign-in");
// a person's chip may name only an account that serves them (onceTarget resolves it with their person). A turn that arrives while another is running waits behind it (runQueuedOver) and shows as waiting.

/**
 * @param {any} sb the Switchboard @param {string} id the thread @param {{ asker: string }} kernelTurn
 * @returns {Promise<{ provider: string, account: string, person: string | null } | null>} the one-turn target, or null when the thread's own account is theirs to use
 */
export async function askerOver(sb, id, kernelTurn) {
  const rec = sb.record(id);
  if (!rec || !kernelTurn || !kernelTurn.asker) return null;
  const provider = rec.provider || "claude", asker = kernelTurn.asker, scope = { project: rec.project, agent: rec.agent };
  const mine = await sb.accountFor({ provider, person: asker, ...scope }).catch(() => null);
  if (mine && mine.id) return mine.id === rec.account ? null : { provider, account: String(mine.id), person: asker };
  if (!rec.account) return null;
  const serves = await sb.accountFor({ provider, account: rec.account, person: asker, ...scope }).catch(() => null);
  if (serves) return null;
  const home = await sb.accountFor({ provider, ...scope }).catch(() => null);
  if (home && home.id) return home.id === rec.account ? null : { provider, account: String(home.id), person: null };
  throw Object.assign(new Error("This chat runs on another member's sign-in, and you have none of your own here. Add your own sign-in to use it. Nothing was sent."), { code: "account_required" });
}

/** Is a turn running on this thread (so another person's one-turn must wait)? @param {any} sb @param {string} id */
export function busyTurn(sb, id) {
  const st = sb.live.get(id), rec = sb.record(id);
  return Boolean(sb.once.has(id) || (st && st.turn && rec && ["working", "waiting"].includes(String(rec.status))));
}

/**
 * A queued one-turn (the turn's facts carry `over`) is run when the thread is free: marked delivered and sent as the one-turn it was asked as. True when this took the rows.
 * @param {any} sb @param {string} id @param {any[]} rows the queued rows of one turn @param {any} kt the turn's facts @param {(at: number, rowId: number) => { changes: number | bigint }} mark @param {number} now
 */
export function runQueuedOver(sb, id, rows, kt, mark, now) {
  if (!kt || !kt.over) return false;
  const r = rows[0];
  if (!mark(now, r.id).changes) return true;
  const rec = sb.record(id);
  // the turn begins here as a queued one does anywhere else: the stream moves the replies (and the notice that the turn moved provider) to ITS asker, not the turn that just ended
  sb.emit("thread.sent", { text: String(r.text).slice(0, 2000), surface: r.surface, queued: Number(r.id), uuid: r.uuid || null, via: "turn", queued_at: Number(r.at), step: 0, ...(r.kind ? { kind: r.kind } : {}), ...(r.request ? { request: r.request } : {}) }, id, rec ? rec.project : null);
  void sb.sendOnce(id, r.text, r.surface, kt.over, { queue: false, kernelTurn: { chat: kt.chat, asker: kt.asker } }).catch((/** @type {Error} */ e) => sb.emit("thread.text", { message: "vyre", text: `Your message could not run on your own account: ${e.message}`, done: true, notice: true }, id, rec ? rec.project : null));
  return true;
}

/** A chip names an account only the sender may use: a turn on the thread's own account is no exception (it may be another member's). Refused in words, nothing sent. @param {any} sb @param {{ provider: string, account?: string | null, person?: string | null }} over */
export async function servesChip(sb, over) {
  if (!over.person || !over.account) return;
  await sb.accountFor({ provider: over.provider, account: over.account, person: over.person }).catch(() => { throw Object.assign(new Error("That account is not yours to use here. Nothing was sent, and the turn did not move to another provider."), { code: "account_unavailable" }); });
}
