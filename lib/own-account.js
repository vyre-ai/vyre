// @ts-check
// The one sentence a person reads when an AI turn is theirs to run and they have no AI account of their own here (the owner's rule, 20 Oct 2026: every turn runs on the account of the person who asked;
// the owner's or the home's is never used for someone else). It names the next step, so it is never a dead end. Shared by the Switchboard's launch gate, the agents module and the task wake.

/** @param {string | null | undefined} agent the agent they wanted to use @returns {string} */
export function connectOwn(agent) {
  return `Connect your own AI account in Settings, AI accounts, to use ${agent ? String(agent).slice(0, 80) : "this"}.`;
}

/** Whether a refusal's words are this one (they cross module calls as text). @param {unknown} message */
export const isConnectOwn = message => /Connect your own AI account in Settings, AI accounts/.test(String(message || ""));
