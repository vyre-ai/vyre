// @ts-check
// A member's own AI key, for the one chat turn that is theirs. The Switchboard has no proof of a person on its own calls, so the lend asks here: the daemon opens a one-turn kernel session for the ASKER ALONE
// (a device chain of that one person, no agent hop, no chat), makes the one call vault.me.lend on it as module:threads, and ends the session in a finally. The token is held in this function only: it is never
// returned, stored, logged or put in an event, and the Switchboard never sees it. The Switchboard has already checked who may be asked for (the stored asker of a turn that is running or being handed over, still in
// the chat, and an account of that same person, memberKey in core/switchboard/member-key.js); the Vault's own pair check (the account is theirs, their vault is unlocked) is the second lock.

const SESSION_MS = 20_000;

/**
 * @param {{ kernel: any, personChainFor: (person: string) => any, callLend: (input: { account: string }, o: { token: string }) => Promise<any> }} o
 * @returns {(q: { asker: string, account: string, space?: string | null }) => Promise<{ data?: { value: string }, error?: { code: string, message: string } }>}
 */
export function lendKey({ kernel, personChainFor, callLend }) {
  return async ({ asker, account, space }) => {
    const denied = (/** @type {string} */ message) => ({ error: { code: "denied", message } });
    // A team Space's chat is a different kernel's: nothing is lent for it from here (fail closed).
    if (!asker || !account || (space && space !== kernel.id.space)) return denied("no key is lent for this turn");
    /** @type {{ token: string, session: string } | null} */ let session = null;
    try {
      const chain = await personChainFor(String(asker));
      session = await kernel.surfaces.open(chain, { ttl_ms: SESSION_MS });
      const r = await callLend({ account: String(account) }, { token: session.token });
      if (r && r.error) return { error: { code: String(r.error.code || "denied"), message: String(r.error.message || "no key is lent for this turn") } };
      return { data: { value: r && r.data && r.data.value } };
    } catch {
      return denied("no key is lent for this turn");
    } finally {
      if (session) { try { kernel.surfaces.revoke(session.session); } catch { /* it expires in seconds anyway */ } }
    }
  };
}
