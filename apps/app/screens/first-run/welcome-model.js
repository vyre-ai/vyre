// @ts-check
// The welcome screen's words and its small rules: the address the person types, the Space last used, the three theme choices. Words are the owner's (polish-proposal/onboarding.html). Pure.
import { chosen, groupsOf } from "../../src/models/model-choice.js";
import { spaceAddressOf } from "../../../../lib/first-run-shape.js";

export const WELCOME_COPY = Object.freeze({
  sub: "The command center for AI-native teams",
  signInTo: "Sign in to",
  suffix: ".vyre.run",
  placeholder: "your-space",
  start: "New here? Get started",
  github: "Sign in with GitHub",
  privacy: "Privacy",
  privacyUrl: "https://vyre.run/privacy",
  terms: "Terms",
  termsUrl: "https://vyre.run/terms",
  footer: "A product of Clearfield Labs",
  footerUrl: "https://clearfieldlabs.com",
  badSpace: "Use the name of a space, like juniper.",
});

/** The model step's words. */
export const MODEL_COPY = Object.freeze({
  /** @param {string} name */
  title: (name) => `How should ${name} think?`,
  lead: "Its default. You can pick a different one in any chat.",
  none: "No AI account is connected yet. Go back to connect one, or continue and pick a model later in Settings.",
  noModels: "Your AI account has not listed its models yet. Continue to use its default, and pick another later in Settings.",
});

/**
 * The model step from what the accounts offer: the line under the title, and whether Continue works. Continue needs a pick only when there is a model to pick; with none it goes on with the default.
 * @param {{ models: unknown[] }[] | null} accounts null while still looking @param {boolean} picked a model is chosen
 */
export function modelStep(accounts, picked) {
  const count = (accounts || []).reduce((n, a) => n + (Array.isArray(a.models) ? a.models.length : 0), 0);
  const lead = accounts === null || count ? MODEL_COPY.lead : accounts.length ? MODEL_COPY.noModels : MODEL_COPY.none;
  return { lead, count, canContinue: accounts !== null && (count === 0 || picked) };
}

/** The Assistant step: its words, and the name offered until the person types one (the server's own fallback is the same). */
export const ASSISTANT_COPY = Object.freeze({
  title: "Name your Assistant.",
  lead: "It's yours alone, always in your chats, and it knows your Space.",
  suggestion: "Juno",
  nameLabel: "Name",
  tooLong: "Use up to 40 characters.",
});

/** The name step's words. */
export const NAME_COPY = Object.freeze({
  title: "What should we call you?",
  lead: "Your name shows on everything you do, so teammates always know who's who.",
  first: "First name",
  last: "Last name",
  bad: "Use letters, up to 60 characters in all.",
});

/** The three theme choices, in order: the person's setting and its label. "system" follows the device or browser and switches live when it changes. */
export const THEME_CHOICES = Object.freeze([["paper", "Light"], ["system", "Match this device"], ["dark", "Dark"]]);

/** The icon for each theme choice: the switch shows only these, each named by its label for screen readers and in its tooltip. Names from the one icon set (src/ui/icons.generated.ts). */
export const THEME_ICONS = Object.freeze({ paper: "sun", system: "laptop", dark: "moon" });

/**
 * The colour role of every word and line on the welcome screen and the unlock cover: token names from tokens v2 (lib/theme/tokens.json, kebab-cased as the theme reads them),
 * each present in light and in dark, so nothing is drawn in a colour the theme does not have (an unknown name falls back to black, unreadable on dark).
 */
export const WELCOME_TONES = Object.freeze({
  wordmark: "text", sub: "label", greeting: "text", line: "text-2", fieldLead: "label", fieldText: "text", placeholder: "label",
  link: "label", footer: "text", error: "err", go: "primary", goInk: "primary-ink", edge: "edge-strong", surface: "surface-1",
});

/** The unlock cover's words: it wears the welcome's look (greeting, a muted line, the round-arrow field). */
export const UNLOCK_COPY = Object.freeze({
  line: "Locked to keep your Space safe.",
  password: "Password",
  recoveryKey: "Recovery key",
  passwordHint: "Type your password",
  recoveryHint: "Type your recovery key",
  unlock: "Unlock",
  unlocking: "Unlocking...",
  useRecovery: "Use my recovery key",
  usePassword: "Use my password",
  show: "Show password",
  hide: "Hide password",
  note: "Vyre locks itself after a quiet spell. You can change how long in Settings, under Account.",
});

/** The key the last Space used is kept under. */
export const SPACE_KEY = "vyre-space";

/** The Space last used on this device, or "". @param {{ getItem(k: string): string | null } | null | undefined} storage */
export function lastSpace(storage) {
  try { const v = storage ? storage.getItem(SPACE_KEY) : ""; return v && /^[a-z][a-z0-9-]{1,38}$/.test(v) ? v : ""; } catch { return ""; }
}

/** Remember a Space for next time. @param {{ setItem(k: string, v: string): void } | null | undefined} storage @param {string} space */
export function rememberSpace(storage, space) {
  try { if (storage && /^[a-z][a-z0-9-]{1,38}$/.test(space)) storage.setItem(SPACE_KEY, space); } catch { /* a private window keeps nothing: the field is just empty next time */ }
}

/** What the person typed in the Space field as a full address: "juniper" and "juniper.vyre.run" are the same Space. Null when it is not one. @param {string} typed */
export function addressFrom(typed) {
  const t = String(typed || "").trim().toLowerCase();
  return spaceAddressOf(t.includes(".") ? t : `${t}.vyre.run`);
}

/**
 * The model step's accounts (onboard.assistant.models: each connected account with the models it can run, in the one shape) as the one picker's groups. @param {any[]} accounts
 * @returns {import("../../src/models/model-choice.js").ModelGroup[]}
 */
export function welcomeGroups(accounts) {
  const list = (accounts || []).filter((a) => a && typeof a.id === "string");
  return groupsOf(list.map((a) => ({ id: String(a.id), label: String(a.label || a.provider || "AI account"), provider: String(a.provider || ""), kind: String(a.kind || "") })), list.map((a) => ({ models: Array.isArray(a.models) ? a.models : [] })));
}

/** The chosen row from the step's pick (an account, a provider and a model), or null. @param {import("../../src/models/model-choice.js").ModelGroup[]} groups @param {{ account: string, provider: string, model: string }} pick */
export const pickedModel = (groups, pick) => chosen(groups, pick);
