// @ts-check
// asker: the AI account an agent's own Watcher asks a model on (its `ask()`): the account of the person who asked for the Watcher, on any provider they hold one on,
// found the way agent runs find it (sessions.accounts.resolve with any). The owner's own default for the owner. Anyone else with none is refused in plain words,
// never run on the owner's account for them.
import { connectOwn } from "../../lib/own-account.js";

/**
 * @param {{ call: (tool: string, input: any) => Promise<{ data?: any, error?: any }>, isOwner: (person: string) => boolean }} deps
 * @param {string|null|undefined} person @param {string} agent
 * @returns {Promise<{ person?: string, account?: string, provider?: string }>} what threads.quick takes
 */
export async function askerAccount({ call, isOwner }, person, agent) {
  if (!person) return {};
  if (isOwner(person)) return { person };
  const r = await call("sessions.accounts.resolve", { provider: "claude", person, agent, any: true }).catch(() => null);
  const acct = r && !r.error ? r.data : null;
  if (acct && !acct.synthetic && acct.person === person && acct.id) return { person, account: String(acct.id), ...(acct.provider ? { provider: String(acct.provider) } : {}) };
  throw new Error(connectOwn(agent));
}
