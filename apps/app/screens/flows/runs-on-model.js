// @ts-check
// "Runs on", a Flow's setting: which of the viewer's OWN AI accounts its AI steps use. The list is the viewer's own accounts (sessions.accounts.list answers only theirs); the server stamps the person from who
// saves the version, refuses anyone but the Flow's maker or the owner for themselves, and refuses an account that is not theirs (kernel/flows/runs-as.js). Only an API key account can run a Flow's AI steps today.

/** The providers a Flow's AI step can run on (the inference door's drivers). */
export const AI_STEP_PROVIDERS = Object.freeze(["openrouter", "openai-compatible"]);

/** @typedef {{ id: string, provider: string, label: string }} Choice */

/** The viewer's own accounts a Flow's AI steps can run on: finished API key accounts of those providers. @param {unknown[]} accounts @returns {Choice[]} */
export function runsOnChoices(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter((/** @type {any} */ a) => a && typeof a.id === "string" && a.kind === "api-key" && AI_STEP_PROVIDERS.includes(String(a.provider)) && !a.pending && !a.synthetic && !a.needs)
    .map((/** @type {any} */ a) => ({ id: String(a.id), provider: String(a.provider), label: String(a.label || a.provider) }));
}

/** The line that says what the Flow runs on now. @param {any} runsOn the stored runs_on, or nothing @param {Choice[]} choices */
export function runsOnLine(runsOn, choices) {
  if (!runsOn || !runsOn.account) return runsOn && runsOn.person ? "Its AI steps run on the default key of the person it runs as." : "Its AI steps run on the default key of the person who made it.";
  const mine = choices.find((c) => c.id === runsOn.account);
  return mine ? `Its AI steps run on your account ${mine.label}.` : "Its AI steps run on an account of the person it runs as.";
}

/** The definition with Runs on set to one of the viewer's accounts. The person is left out: the server sets it to whoever saves. @param {unknown} flow @param {Choice} choice */
export function withRunsOn(flow, choice) {
  const f = flow && typeof flow === "object" ? /** @type {Record<string, unknown>} */ (flow) : {};
  return { ...f, runs_on: { account: choice.id, provider: choice.provider } };
}
