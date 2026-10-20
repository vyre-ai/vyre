// @ts-check
// "Runs on", a Flow's setting: which of the viewer's OWN AI accounts its AI steps use. The list is the viewer's own accounts (sessions.accounts.list answers only theirs); the server stamps the person from who
// saves the version, refuses anyone but the Flow's maker or the owner for themselves, and refuses an account that is not theirs (kernel/flows/runs-as.js). Every finished account runs them: an API key
// (OpenRouter, OpenAI-compatible) through the inference door's HTTP driver, and a subscription sign-in (Claude, Codex, Grok) or a key those take through the provider's own CLI (core/daemon/flow-model.js).

/** The providers a Flow's AI step can run on (the inference door's drivers): keys, then sign-ins. */
export const AI_STEP_PROVIDERS = Object.freeze(["openrouter", "openai-compatible", "claude", "codex", "grok"]);
const SIGNIN = new Set(["claude", "codex", "grok"]);
const NAMES = /** @type {Record<string, string>} */ ({ openrouter: "OpenRouter", "openai-compatible": "OpenAI-compatible", claude: "Claude", codex: "Codex", grok: "Grok" });

/** @typedef {{ id: string, provider: string, label: string, kind: string }} Choice */

/** The viewer's own accounts a Flow's AI steps can run on: finished keys and sign-ins of those providers (a sign-in to an address of its own is not one yet). @param {unknown[]} accounts @returns {Choice[]} */
export function runsOnChoices(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter((/** @type {any} */ a) => a && typeof a.id === "string" && AI_STEP_PROVIDERS.includes(String(a.provider)) && !a.pending && !a.synthetic && !a.needs
      && (SIGNIN.has(String(a.provider)) ? ["login", "setup-token", "api-key"].includes(String(a.kind)) && !a.base_url : a.kind === "api-key"))
    .map((/** @type {any} */ a) => ({ id: String(a.id), provider: String(a.provider), label: String(a.label || a.provider), kind: String(a.kind) }));
}

/** What kind of account a choice is, in a few words ("Claude subscription", "OpenRouter key"). @param {Choice} c */
export function choiceKind(c) {
  const name = NAMES[c.provider] || c.provider;
  return SIGNIN.has(c.provider) && c.kind !== "api-key" ? `${name} subscription` : `${name} key`;
}

/** The line that says what the Flow runs on now. @param {any} runsOn the stored runs_on, or nothing @param {Choice[]} choices */
export function runsOnLine(runsOn, choices) {
  if (!runsOn || !runsOn.account) return runsOn && runsOn.person ? "Its AI steps run on the default AI account of the person it runs as." : "Its AI steps run on the default AI account of the person who made it.";
  const mine = choices.find((c) => c.id === runsOn.account);
  return mine ? `Its AI steps run on your account ${mine.label}.` : "Its AI steps run on an account of the person it runs as.";
}

/** The definition with Runs on set to one of the viewer's accounts. The person is left out: the server sets it to whoever saves. @param {unknown} flow @param {{ id: string, provider: string }} choice */
export function withRunsOn(flow, choice) {
  const f = flow && typeof flow === "object" ? /** @type {Record<string, unknown>} */ (flow) : {};
  return { ...f, runs_on: { account: choice.id, provider: choice.provider } };
}
