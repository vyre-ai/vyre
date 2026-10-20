// @ts-check
// A Flow's "AI accounts" tab: which of the viewer's OWN AI accounts its AI steps use, a main one and an optional fallback, each with a model. The list is the viewer's own accounts
// (sessions.accounts.list answers only theirs); the server stamps the person from who saves the version, refuses anyone but the Flow's maker or the owner for themselves, and refuses an account that is not
// theirs (kernel/flows/runs-as.js). The fallback answers when the main one is out of credits, rate limited, signed out or not answering (core/daemon/flow-model.js).

import { AIS } from "../../../../lib/ai-ids.js";

/** The one line the tab says. */
export const AI_ACCOUNTS_LINE = "Runs on these accounts no matter who or what starts it.";
/** The providers a Flow's AI step can run on (the inference door's drivers): keys, then sign-ins (core/daemon/flow-model.js). */
export const AI_STEP_PROVIDERS = Object.freeze(["openrouter", "openai-compatible", ...AIS]);
const SIGNIN = new Set(AIS);
const NAMES = /** @type {Record<string, string>} */ ({ openrouter: "OpenRouter", "openai-compatible": "OpenAI-compatible", claude: "Claude", codex: "Codex", grok: "Grok" });
/** The step kinds that call a model on the Flow's accounts. */
const AI_KINDS = new Set(["classify", "extract"]);

/** @typedef {{ id: string, provider: string, label: string, kind: string }} Choice */
/** @typedef {{ account: string, provider?: string, model?: string }} Pick */

/** Does this Flow have an AI step anywhere (inside a decision, a repeat or a lane too)? The tab shows only then. @param {unknown} flow @returns {boolean} */
export function hasAiStep(flow) {
  /** @type {unknown[]} */ const todo = [flow];
  let n = 0;
  while (todo.length && n++ < 5000) {
    const x = todo.pop();
    if (Array.isArray(x)) { todo.push(...x); continue; }
    if (!x || typeof x !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (x);
    if (typeof o.kind === "string" && AI_KINDS.has(o.kind) && typeof o.id === "string") return true;
    for (const k of ["steps", "then", "else", "on_failure", "lanes", "branches", "do"]) if (o[k] !== undefined) todo.push(o[k]);
  }
  return false;
}

/** The viewer's own finished accounts a Flow's AI steps can run on: keys and sign-ins of those providers (a sign-in to an address of its own is not one yet). @param {unknown} accounts @returns {Choice[]} */
export function aiChoices(accounts) {
  const list = Array.isArray(accounts) ? accounts : accounts && typeof accounts === "object" && Array.isArray(/** @type {any} */ (accounts).accounts) ? /** @type {any} */ (accounts).accounts : [];
  return list
    .filter((/** @type {any} */ a) => a && typeof a.id === "string" && AI_STEP_PROVIDERS.includes(String(a.provider)) && !a.pending && !a.synthetic && !a.needs
      && (SIGNIN.has(String(a.provider)) ? ["login", "setup-token", "api-key"].includes(String(a.kind)) && !a.base_url : a.kind === "api-key"))
    .map((/** @type {any} */ a) => ({ id: String(a.id), provider: String(a.provider), label: String(a.label || a.provider), kind: String(a.kind || "login") }));
}

/** The Flow's main and fallback as stored (the first form, { account, provider }, is the main one). @param {unknown} flow @returns {{ main: Pick | null, fallback: Pick | null }} */
export function storedAccounts(flow) {
  const r = flow && typeof flow === "object" ? /** @type {any} */ (flow).runs_on : null;
  const pick = (/** @type {any} */ x) => (x && typeof x.account === "string" ? { account: String(x.account), ...(x.provider ? { provider: String(x.provider) } : {}), ...(x.model ? { model: String(x.model) } : {}) } : null);
  if (!r || typeof r !== "object") return { main: null, fallback: null };
  return { main: pick(r.main) || pick(r.account ? { account: r.account, provider: r.provider } : null), fallback: pick(r.fallback) };
}

/** What a pick reads as, from the viewer's side. @param {Pick | null} p @param {Choice[]} choices */
export function pickWords(p, choices) {
  if (!p) return "Your default AI account";
  const c = choices.find((x) => x.id === p.account);
  return `${c ? c.label : "An account of the person it runs as"}${p.model ? `, ${p.model}` : ""}`;
}

/** The definition with its AI accounts set to the viewer's picks. The person is left out: the server sets it to whoever saves. @param {unknown} flow @param {Pick} main @param {Pick | null} fallback */
export function withAccounts(flow, main, fallback) {
  const f = flow && typeof flow === "object" ? /** @type {Record<string, unknown>} */ (flow) : {};
  const clean = (/** @type {Pick} */ p) => ({ account: p.account, ...(p.provider ? { provider: p.provider } : {}), ...(p.model ? { model: p.model } : {}) });
  return { ...f, runs_on: { main: clean(main), ...(fallback && fallback.account !== main.account ? { fallback: clean(fallback) } : {}) } };
}

/** What kind of account a choice is, in a few words ("Claude subscription", "OpenRouter key"). @param {Choice} c */
export function choiceKind(c) {
  const name = NAMES[c.provider] || c.provider;
  return SIGNIN.has(c.provider) && c.kind !== "api-key" ? `${name} subscription` : `${name} key`;
}
