// @ts-check
// The assistant exists once the server has an owner AND an AI account is connected (0.3 order: the owner arrives by pairing, so no first-run page names the assistant). Until then Now
// says one plain thing, and an assistant whose account is later disconnected stays and says it has no account. Pure over its ports so it is tested without a daemon; core/onboard/index.js
// runs it once at start and when what it depends on changes (owner adopted or seen, an AI account connected or disconnected), never on a timer.

/** Say this while the assistant waits for an account. */
export const WAITING = "Connect an AI account to start your assistant";
/** Say this when the assistant exists and its account is gone. */
export const NO_ACCOUNT = "Your assistant has no AI account connected";

/**
 * @param {{ tryCall: (tool: string, input?: any) => Promise<any>, call: (tool: string, input?: any) => Promise<any>, signedInOutside?: () => boolean,
 *   ensure: (o: { fallbackName: boolean }) => Promise<{ made: boolean }>, state: () => any, setState: (s: any) => void, hasOwner?: () => boolean | Promise<boolean> }} p
 * @returns {Promise<"exists"|"no_account"|"no_owner"|"waiting"|"made"|"failed">}
 */
export async function assistantWhenReady({ tryCall, call, signedInOutside = () => false, ensure, state, setState, hasOwner = () => false }) {
  const list = await call("agents.list").catch(() => null);
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.agents) ? list.agents : [];
  const exists = rows.some((/** @type {any} */ a) => a && a.kind === "assistant");
  const providers = await tryCall("providers.list");
  // providers.list reports the machine's own Claude login as account "default", signed in, always (it is a stand-in row, not a connection), so it counts for nothing here; any other
  // signed-in account does, and so does onboard's own Claude connection.
  const connected = signedInOutside() || (Array.isArray(providers) && providers.some((/** @type {any} */ p) => Array.isArray(p.accounts) && p.accounts.some((/** @type {any} */ a) => a && a.signed_in === true && !(a.id === "default" && a.kind === "login"))));
  /** Write a state once, not on every check. @param {"waiting"|"no_account"|null} kind @param {string} [why] */
  const say = (kind, why) => {
    const cur = state();
    if (kind === null) { if (cur && (cur.state === "waiting" || cur.state === "no_account")) setState(null); return; }
    if (!cur || cur.state !== kind) setState({ state: kind, why, at: new Date().toISOString() });
  };
  if (exists) {
    if (connected) say(null); else say("no_account", NO_ACCOUNT);
    return connected ? "exists" : "no_account";
  }
  const id = await tryCall("spaces.identity.id");
  const owned = await tryCall("wink.server.owned");
  const owner = Boolean(await hasOwner() || (owned && !owned.__error && owned.owned === true) || (id && !id.__error && id.id));
  if (!owner) return "no_owner";
  if (!connected) { say("waiting", WAITING); return "waiting"; }
  const r = await ensure({ fallbackName: true });
  if (r.made) say(null);
  return r.made ? "made" : "failed";
}
