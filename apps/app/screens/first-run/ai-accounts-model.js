// @ts-check
// The AI accounts step: which providers can be added, what an account is called, and which provider an API key belongs to. An account is a name and a provider; a person may have several of one kind. Pure.
import { AIS } from "../../../../lib/ai-ids.js";
import { CREDENTIAL_PREFIXES, anthropicKind } from "../../../../lib/credential-shapes.js";

/** The words of the step. */
export const ACCOUNTS_COPY = Object.freeze({
  title: "Connect your AI.",
  lead: "Your agents think with your own AI accounts. Add as many as you like: several of one kind is fine. You can skip this and add them later in Settings.",
  nameLabel: "Name this account",
  add: "Add account",
  check: "I signed in",
  signing: "Finish signing in in the window that opened, then press the button.",
  pasteLabel: "The code the page showed",
  pasteHelp: "The sign-in page shows a code. Paste it here, then press Continue.",
  paste: "Continue",
  cancel: "Cancel",
  empty: "Add an AI account, or press Skip for now.",
  tooLong: "Use up to 80 characters.",
  keyTile: "API key",
  keyPassword: "Your password, to open your own Vault",
  keyLabel: "API key",
  keyHelp: "Checked with the provider, kept in your Vault, and never shown again.",
  keyUnknown: "That does not look like a key we know. Check it, or add the account by signing in with its provider.",
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

/** The prefixes the credential table gives Anthropic keys (a prefix that, padded to a full key, the table calls an Anthropic one), so the shape is written once, in lib/credential-shapes.js. */
const ANTHROPIC_PREFIXES = CREDENTIAL_PREFIXES.filter((p) => anthropicKind(p + "A".repeat(24)));

/**
 * What an API key is, from its prefix: the kind the server's key tool takes (sessions.accounts.key), the provider mark to show, a name to offer, and for xAI the one address it is sent to. Anthropic keys start
 * sk-ant-, OpenRouter keys sk-or-, xAI keys xai-, other OpenAI-style keys sk-. Null when the prefix says nothing.
 * @param {string} key @returns {{ kind: "anthropic-compatible" | "openai-compatible" | "openrouter" | "opencode", provider: string, label: string, base_url?: string } | null}
 */
export function keyKindOf(key) {
  const k = String(key || "").trim();
  if (ANTHROPIC_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) return { kind: "anthropic-compatible", provider: "claude", label: "Claude key" };
  if (/^sk-or-/i.test(k)) return { kind: "openrouter", provider: "openrouter", label: "OpenRouter key" };
  if (/^xai-/i.test(k)) return { kind: "openai-compatible", provider: "grok", label: "Grok key", base_url: "https://api.x.ai/v1" };
  if (/^sk-/i.test(k)) return { kind: "openai-compatible", provider: "codex", label: "OpenAI key" };
  if (keyShapeOk(k)) return { kind: "opencode", provider: "opencode", label: "OpenCode key" };
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
    confirm: count === 0 ? "Nothing to confirm." : `You'll confirm ${asks} times: once to read ${count === 1 ? "the key" : `each of the ${count} keys`} from ${from}, and once to add ${count === 1 ? "it" : "them"} to ${to}.`,
    again: "Sign in again on the new Space",
    button: (/** @type {number} */ n) => (n === 1 ? "Copy 1 account" : `Copy ${n} accounts`),
  };
}

/**
 * What the sign-in of one provider is waiting for. A provider whose page shows a code to paste back (the home answered step "url") needs that code typed here; one that finishes by itself (the home shows its own code, or the person
 * just approves) needs only "I signed in". @param {string} flow the flow id the home gave, or "" before one @param {string} step the step the home answered @param {boolean} [paste] the home said the login takes a pasted code (core/sessions/signin.js status: paste: true, with step "url" until the command ends)
 * @returns {"start" | "paste" | "wait"}
 */
export function signinMode(flow, step, paste = false) {
  if (!flow) return "start";
  return step === "url" || paste === true ? "paste" : "wait";
}

/**
 * The sign-in call's input. The code sent is ONLY the one the person pasted from the provider's page: the code the home itself shows (to type at the provider) is never sent back as if it were theirs.
 * @param {{ provider: string, label: string, flow: string, step: string, pasted: string, paste?: boolean }} o
 */
export function signinInput({ provider, label, flow, step, pasted, paste = false }) {
  const code = pasted.trim();
  return { provider, label: label.trim(), ...(flow ? { flow } : {}), ...(signinMode(flow, step, paste) === "paste" && code ? { code } : {}) };
}

/** Whether the pasted code can be sent: something was typed, one line, within the home's own bound of 200. @param {string} pasted */
export const pasteOk = (pasted) => { const c = pasted.trim(); return c.length > 0 && c.length <= 200 && !/[\u0000-\u001f]/.test(c); };

/** The state after Cancel: no flow, no link, no code, nothing pasted, so the provider tiles and the key tile work again. */
export const NO_SIGNIN = Object.freeze({ flow: "", url: "", code: "", step: "", pasted: "", paste: false });
