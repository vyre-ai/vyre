// @ts-check
// The assistant exists once the server has an owner AND an AI account is connected (0.3 order: the owner arrives by pairing, so no first-run page names the assistant). Until then Now
// says one plain thing. Pure over its ports so it is tested without a daemon; core/onboard/index.js runs it on start and once a minute.

/** Say this while the assistant waits. */
export const WAITING = "Connect an AI account to start your assistant";

/**
 * @param {{ tryCall: (tool: string, input?: any) => Promise<any>, call: (tool: string, input?: any) => Promise<any>, signedInOutside?: () => boolean,
 *   ensure: (o: { fallbackName: boolean }) => Promise<{ made: boolean }>, state: () => any, setState: (s: any) => void, hasOwner?: () => boolean }} p
 * @returns {Promise<"exists"|"no_owner"|"waiting"|"made"|"failed">}
 */
export async function assistantWhenReady({ tryCall, call, signedInOutside = () => false, ensure, state, setState, hasOwner = () => false }) {
  const list = await call("agents.list").catch(() => null);
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.agents) ? list.agents : [];
  if (rows.some((/** @type {any} */ a) => a && a.kind === "assistant")) return "exists";
  const id = await tryCall("spaces.identity.id");
  const owner = Boolean(hasOwner() || (id && !id.__error && id.id));
  if (!owner) return "no_owner";
  const providers = await tryCall("providers.list");
  const connected = signedInOutside() || (Array.isArray(providers) && providers.some((/** @type {any} */ p) => Array.isArray(p.accounts) && p.accounts.some((/** @type {any} */ a) => a && a.signed_in === true)));
  if (!connected) {
    const cur = state();
    if (!cur || cur.state !== "waiting") setState({ state: "waiting", why: WAITING, at: new Date().toISOString() });
    return "waiting";
  }
  const r = await ensure({ fallbackName: true });
  return r.made ? "made" : "failed";
}
