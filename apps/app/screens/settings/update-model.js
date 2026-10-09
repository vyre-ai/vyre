// @ts-check
// "A new version is out" (SPEC-0.3.0 item 1.9): what Now says and what Settings, About shows with its one Update button. Pure: the screens give it the box's `update.status` answer and draw what
// comes back. The update itself is the box's (update.apply drops a request its own unit acts on, after checking the release's signature); this file only says what to show.

/** @typedef {{ current: string, available: string | null, how?: string, command?: string | null, canApply?: boolean, pending?: boolean, error?: string | null, auto?: string }} Status */

/** Whether Now shows the "a new version is out" card: a newer release is known and nothing is installing it already. @param {Status | null | undefined} s */
export function showNotice(s) {
  return Boolean(s && s.available && s.available !== s.current && !s.pending);
}

/** The card's words. @param {Status} s */
export function noticeLines(s) {
  return {
    title: `Vyre ${s.available} is out`,
    detail: `You are on ${s.current}. ${s.canApply ? "Updating keeps your data, your vault and your sign-ins." : howToLine(s)}`.trim(),
  };
}

/** How to update when the app cannot do it from here: the one command, or the app that installed Vyre. @param {Status} s */
export function howToLine(s) {
  if (s.canApply) return "";
  return s.command ? `To update, run ${s.command} on your server.` : "Update from the app that installed Vyre.";
}

/**
 * About's one button. Up to date: it looks for a newer release. A newer one that this box can install: it installs it. A newer one it cannot install from here: no button, the line says how.
 * While one installs: no button. @param {Status | null | undefined} s @returns {{ label: string, action: "check" | "apply" } | null}
 */
export function aboutButton(s) {
  if (!s || s.pending) return null;
  if (s.available && s.available !== s.current) return s.canApply ? { label: `Update to ${s.available}`, action: "apply" } : null;
  return { label: "Check for updates", action: "check" };
}

/** About's line under the version. @param {Status | null | undefined} s */
export function aboutLine(s) {
  if (!s) return "";
  if (s.pending) return "An update is being installed. Vyre restarts when it is done.";
  if (s.error) return `The last look for a new version failed: ${s.error}`;
  if (s.available && s.available !== s.current) return `Vyre ${s.available} is out. ${s.canApply ? "Updating keeps your data, your vault and your sign-ins." : howToLine(s)}`.trim();
  return "You are on the newest version.";
}

/** What the toast says after update.apply answered. @param {{ requested?: boolean, reason?: string } | null | undefined} r */
export function appliedLine(r) {
  return r && r.requested === false ? (r.reason || "The update did not start.") : "Updating. Vyre restarts in a minute or two.";
}
