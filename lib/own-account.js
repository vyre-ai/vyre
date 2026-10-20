// @ts-check
// The one sentence a person reads when an AI turn is theirs to run and they have no AI account of their own here (the owner's rule, 20 Oct 2026: every turn runs on the account of the person who asked;
// the owner's or the home's is never used for someone else). It names the next step, so it is never a dead end. Shared by the Switchboard's launch gate, the agents module and the task wake.

/** @param {string | null | undefined} agent the agent they wanted to use @returns {string} */
export function connectOwn(agent) {
  return `Connect your own AI account in Settings, AI accounts, to use ${agent ? String(agent).slice(0, 80) : "this"}.`;
}

/** Whether a refusal's words are this one (they cross module calls as text). @param {unknown} message */
export const isConnectOwn = message => /Connect your own AI account in Settings, AI accounts/.test(String(message || ""));

// Rule 2 of the product map: a run acts for a person, and no person means no agent work. The words a call meets when nothing on it names a person (a module's own call, a schedule or a duty made
// before Vyre recorded who it runs for): it is refused, never run as the owner. Shared by the agents, team and planner modules.
export const NO_PERSON = "No person asked for this, so no agent was started.";

/** The refusal, with the next step. @param {string} [next] what the person does instead @returns {string} */
export function noPerson(next = "Ask again from your own signed-in Vyre.") {
  return `${NO_PERSON} ${next}`;
}

/** Whether a refusal's words are this one (they cross module calls as text). @param {unknown} message */
export const isNoPerson = message => /No person asked for this, so no agent was started/.test(String(message || ""));

/** What a paused item shows when it was made before Vyre recorded who it runs for: on upgrade it is paused, never run as the owner, until a person turns it on as themselves. */
export const MADE_BEFORE = "Paused: made before Vyre recorded who it runs for. Turn it on to run it as you.";
