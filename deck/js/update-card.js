// @ts-check
// update-card: what Settings' Update card says, from update.status. Plain data, no page, so it can be tested.

import { since } from "./fmt.js";

const str = v => (typeof v === "string" ? v : "");

/** The words for each step the host reports (core/update readRun keeps only these). */
export const STAGE_WORDS = {
  start: "Starting", checking: "Looking for the release", downloading: "Downloading it", verifying: "Checking its signature",
  "backing-up": "Backing up your data", installing: "Installing", restarting: "Restarting Vyre", "rolling-back": "Putting the old version back",
  finished: "Done", "too-soon": "An update just ran", none: "Working",
};

/**
 * What the Update card says, from update.status: plain data, so it can be tested without a page.
 * `busy` means the card should keep asking (a request waits for the host, or a run is going); `result` is the last run's
 * outcome in words, shown until it is a day old.
 * @param {any} s
 * @param {number} [now]
 * @returns {{ headline: string, detail: string, command: string | null, app: boolean, notes: { version: string, notes: string }[], version: string | null,
 *   canApply: boolean, busy: boolean, progress: string | null, result: null | { ok: boolean, text: string } }}
 */
export function updateCard(s, now = Date.now()) {
  const current = str(s && s.current) || "unknown";
  const available = str(s && s.available) || null;
  const notes = (Array.isArray(s && s.notes) ? s.notes : []).slice(0, 8).map(n => ({ version: str(n && n.version), notes: str(n && n.notes) })).filter(n => n.version);
  const app = Boolean(s) && s.how === "app";
  const command = !app && s && typeof s.command === "string" && /^[a-z][a-z -]{0,40}$/.test(s.command) ? s.command : null;
  const canApply = Boolean(s && s.canApply === true) && !app;
  const run = s && s.run && typeof s.run === "object" ? s.run : null;
  const running = Boolean(run && run.state === "running");
  const busy = running || Boolean(s && s.pending === true);
  const progress = running ? (STAGE_WORDS[run.stage] || STAGE_WORDS.none) : s && s.pending === true ? "Waiting for this server to start it" : null;
  /** @type {null | { ok: boolean, text: string }} */
  let result = null;
  if (run && !running && (!run.at || now - run.at < 24 * 3600_000)) {
    const to = str(run.to), from = str(run.from);
    if (run.state === "ok") result = { ok: true, text: to && to === current ? `Updated to ${to}.` : to ? `Updated to ${to}.` : "Updated." };
    else if (run.state === "rolled_back") result = { ok: false, text: `${to ? `${to} did not start, so` : "The new version did not start, so"} Vyre put ${from || "the old version"} back and your data is as it was.` };
    else if (run.state === "failed") result = { ok: false, text: `The update did not happen${str(run.message) ? `: ${str(run.message)}` : ""}. Nothing was changed.` };
  }
  if (available) return { headline: `Vyre ${available} is out`, detail: `You run ${current}.`, command, app, notes, version: available, canApply, busy, progress, result };
  const detail = s && s.error ? `Could not look for updates: ${str(s.error)}`
    : s && s.auto === "off" ? "Looking for updates is turned off."
    : s && s.checkedAt ? `Last looked ${since(s.checkedAt)} ago.` : "Not looked yet.";
  return { headline: `Vyre ${current} is up to date`, detail, command: null, app, notes: [], version: null, canApply: false, busy, progress, result };
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
