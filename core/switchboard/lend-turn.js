// @ts-check
// lend-turn: who a member's own AI key may be lent to, settled before the daemon is asked (memberKey -> lendKey). The conditions, each a test (lend-turn.test.js):
//  - the asker is the verified asker this launch carries, or the asker stored for the turn running or being handed over; none is a refusal, and two that differ are a refusal (a stale asker never lends for another's turn);
//  - the asker is still in the chat now (assertAsker, the kernel's own check), and the chat is the thread's;
//  - the account is the one accountFor chose for that asker: its person is the asker, never another's.
// The Vault's pair check (the account is theirs, their vault is unlocked) stays the second lock.

const refuse = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "no_credential" });

/**
 * @param {any} sb the Switchboard @param {string} id the thread @param {any} rec @param {any} o the launch options (kernelTurn) @param {any} acct the account row accountFor chose
 * @returns {Promise<{ asker: string, space: string | null }>}
 */
export async function lendTurn(sb, id, rec, o, acct) {
  const canon = (/** @type {string} */ x) => (typeof sb.canon === "function" ? sb.canon(x) : x);
  const label = acct && acct.label ? String(acct.label) : "that account";
  const not = () => refuse(`${label} is not available to this turn: it is a key of one person, used only in their own turns. Start the chat as that person, or choose an account of your own`);
  const verified = o && o.kernelTurn && o.kernelTurn.asker ? String(o.kernelTurn.asker) : null;
  const stored = sb.turnAsker.get(id) || null;
  if (verified && stored && canon(verified) !== canon(String(stored))) throw not();
  const asker = verified || (stored ? String(stored) : null);
  if (!asker || !acct || !acct.person || canon(String(acct.person)) !== canon(asker)) throw not();
  const chat = (o && o.kernelTurn && o.kernelTurn.chat) || (rec && rec.chat) || null;
  if (!chat) throw not();
  const space = (o && o.kernelTurn && o.kernelTurn.space) || sb.turnSpace.get(id) || null;
  try { await sb.assertAsker(id, rec, { chat, asker, ...(space ? { space } : {}) }); } catch { throw not(); }
  return { asker, space };
}
