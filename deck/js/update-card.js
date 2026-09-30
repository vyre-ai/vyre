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


/** @type {{ title: string, says: string[], commands: { line: string, note: string }[] }[]} */
export const COMMAND_CARDS = [
  { title: "Export everything",
    says: ["One sealed file with your settings, memory, projects, teammates, conversations, session transcripts, project files and your vault.",
      "It opens only with the passphrase you type when you make it. Sign-ins to Claude, ChatGPT and Grok are left out and made again by signing in after a restore. A cut-off export picks up where it stopped when you run it again."],
    commands: [{ line: "vyre backup", note: "shows the sizes first, then asks for a passphrase" },
      { line: "vyre backup --skip-projects --skip-transcripts", note: "your data only, without the files" }] },
  { title: "Uninstall",
    says: ["Stops Vyre, removes its containers, its images and its agents' computers, and takes the vyre command off. Your data stays unless you say to delete it.",
      "It never touches your Docker, your Tailscale, or Claude, Codex and Gemini on any device. The server still shows in your Tailscale machines list: remove it there."],
    commands: [{ line: "vyre uninstall", note: "on the server; asks whether to delete your data too" },
      { line: "vyre uninstall --keep-data", note: "removes Vyre and keeps everything, so a fresh install picks up where this left off" },
      { line: "vyre uninstall --delete-data", note: "removes Vyre and all of its data for good: make an export first" }] },
];
