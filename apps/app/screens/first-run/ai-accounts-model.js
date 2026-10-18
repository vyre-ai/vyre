// @ts-check
// The AI accounts step: which providers can be added, what an account is called, and which provider an API key belongs to. An account is a name and a provider; a person may have several of one kind. Pure.
import { AIS } from "../../../../lib/ai-ids.js";
import { anthropicKind } from "../../src/store-core/credential-shapes.js";

/** The words of the step. */
export const ACCOUNTS_COPY = Object.freeze({
  title: "Connect your AI.",
  lead: "Your agents think with your own AI accounts. Add as many as you like: several of one kind is fine. You can skip this and add them later in Settings.",
  nameLabel: "Name this account",
  add: "Add account",
  check: "I signed in",
  signing: "Finish signing in in the window that opened, then press the button.",
  empty: "Add an AI account, or press Skip for now.",
  tooLong: "Use up to 80 characters.",
  keyTile: "API key",
  keyPassword: "Your password, to open your own Vault",
  keyLabel: "API key",
  keyHelp: "Checked with the provider, kept in your Vault, and never shown again.",
  keyUnknown: "That does not look like a key we know. Check it, or add a Claude, Codex or Grok account by signing in.",
});

/** The provider ids the first run can sign in to, in the order shown. */
export const PROVIDERS = AIS;

/** The name an account gets before the person types one: the provider's, then "Claude 2", "Claude 3" when that name is taken. @param {string} label the provider's name @param {readonly string[]} taken the names already used */
export function defaultLabel(label, taken) {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let n = 2; n < 100; n++) if (!used.has(`${label} ${n}`.toLowerCase())) return `${label} ${n}`;
  return `${label} ${taken.length + 1}`;
}

/** Whether a typed account name can be used: one to 80 characters, one line, and not the name of an account already added. @param {string} label @param {readonly string[]} taken */
export function labelProblem(label, taken) {
  const t = label.trim();
  if (!t) return "Give the account a name.";
  if (t.length > 80 || /[\u0000-\u001f]/.test(t)) return ACCOUNTS_COPY.tooLong;
  if (taken.some((x) => x.trim().toLowerCase() === t.toLowerCase())) return "You already have an account with that name.";
  return "";
}

/**
 * What an API key is, from its prefix: the kind the server's key tool takes (sessions.accounts.key), the provider mark to show, a name to offer, and for xAI the one address it is sent to. Anthropic keys start
 * sk-ant-, OpenRouter keys sk-or-, xAI keys xai-, other OpenAI-style keys sk-. Null when the prefix says nothing.
 * @param {string} key @returns {{ kind: "anthropic-compatible" | "openai-compatible" | "openrouter", provider: string, label: string, base_url?: string } | null}
 */
export function keyKindOf(key) {
  const k = String(key || "").trim();
  if (anthropicKind(`${k.toLowerCase()}${"a".repeat(24)}`)) return { kind: "anthropic-compatible", provider: "claude", label: "Claude key" };
  if (/^sk-or-/i.test(k)) return { kind: "openrouter", provider: "openrouter", label: "OpenRouter key" };
  if (/^xai-/i.test(k)) return { kind: "openai-compatible", provider: "grok", label: "Grok key", base_url: "https://api.x.ai/v1" };
  if (/^sk-/i.test(k)) return { kind: "openai-compatible", provider: "codex", label: "OpenAI key" };
  return null;
}

/** Whether a typed key could be a key at all (the server's own bounds): 12 to 400 characters, no spaces. @param {string} key */
export const keyShapeOk = (key) => { const k = String(key || "").trim(); return k.length >= 12 && k.length <= 400 && !/[\s\u0000-\u001f\u007f]/.test(k); };

/** What the copy sheet says before anything is read: where from, where to, and how many times the person will be asked (a read of each key from the other Space, then one for the whole set). @param {{ from: string, to: string, count: number }} i */
export function copyWords({ from, to, count }) {
  const asks = count + 1;
  return {
    title: "Use your AI accounts here too?",
    lead: `Copy keys from ${from} to ${to}. ${to} keeps each key in your own Vault.`,
    confirm: count === 0 ? "Nothing to confirm." : `You'll confirm ${asks} times: once to read each of ${count === 1 ? "the key" : `the ${count} keys`} from ${from}, and once to add ${count === 1 ? "it" : "them"} to ${to}.`,
    again: "Sign in again on the new Space",
    button: (/** @type {number} */ n) => (n === 1 ? "Copy 1 account" : `Copy ${n} accounts`),
  };
}
