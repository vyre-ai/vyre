// @ts-check
// The welcome screen's words and its small rules: the address the person types, the Space last used, the three theme choices. Words are the owner's (polish-proposal/onboarding.html). Pure.
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
  badSpace: "Use the name of a space, like juniper.",
});

/** The three theme choices, in order: the person's setting and its label. "system" follows the device or browser and switches live when it changes. */
export const THEME_CHOICES = Object.freeze([["paper", "Light"], ["system", "Match this device"], ["dark", "Dark"]]);

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
