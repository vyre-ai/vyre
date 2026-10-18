// @ts-check
// The AI accounts step: which providers can be added, what an account is called, and which provider an API key belongs to. An account is a name and a provider; a person may have several of one kind. Pure.
import { AIS } from "../../../../lib/ai-ids.js";

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

/** Which provider an API key belongs to, from its prefix: Anthropic keys start sk-ant-, OpenAI keys sk- (sk-proj-), xAI keys xai-. Null when the prefix says nothing. @param {string} key */
export function providerOfKey(key) {
  const k = String(key || "").trim();
  if (/^sk-ant-/i.test(k)) return "claude";
  if (/^xai-/i.test(k)) return "grok";
  if (/^sk-/i.test(k)) return "codex";
  return null;
}
