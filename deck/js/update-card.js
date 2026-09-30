// @ts-check
// update-card: what Settings' Update card says, from update.status. Plain data, no page, so it can be tested.

import { since } from "./fmt.js";

const str = v => (typeof v === "string" ? v : "");

/**
 * What the Update card says, from update.status: plain data, so it can be tested without a page.
 * @param {any} s
 * @returns {{ headline: string, detail: string, command: string | null, app: boolean, notes: { version: string, notes: string }[], version: string | null }}
 */
export function updateCard(s) {
  const current = str(s && s.current) || "unknown";
  const available = str(s && s.available) || null;
  const notes = (Array.isArray(s && s.notes) ? s.notes : []).slice(0, 8).map(n => ({ version: str(n && n.version), notes: str(n && n.notes) })).filter(n => n.version);
  const app = Boolean(s) && s.how === "app";
  const command = !app && s && typeof s.command === "string" && /^[a-z][a-z -]{0,40}$/.test(s.command) ? s.command : null;
  if (available) return { headline: `Vyre ${available} is out`, detail: `You run ${current}.`, command, app, notes, version: available };
  const detail = s && s.error ? `Could not look for updates: ${str(s.error)}`
    : s && s.auto === "off" ? "Looking for updates is turned off."
    : s && s.checkedAt ? `Last looked ${since(s.checkedAt)} ago.` : "Not looked yet.";
  return { headline: `Vyre ${current} is up to date`, detail, command: null, app, notes: [], version: null };
}

