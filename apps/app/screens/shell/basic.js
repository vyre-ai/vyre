// @ts-check
// A Basic personal space is one with no server (CHAT 5 Oct 03:15Z): chats and projects work as normal, but Planner, tasks, reminders, notes, Records and flows need a space on a server. On Basic those places
// say one plain line, offer the team spaces the person is in, and offer a server of their own. This file is the pure part: which space is Basic, which places are gated, and the backup line.

export const NEEDS_SERVER = "This needs a Cloud space";
export const ADD_SERVER = "Set up My Cloud";

/** Is this space row a personal space with no server? Read only from the box's `tier` field ("basic" or "cloud"); a team or joined space is always cloud. @param {{ tier?: string } | null | undefined} row */
export const isBasicRow = (row) => Boolean(row) && row?.tier === "basic";

/**
 * The places a Personal (no server) space cannot have. With no Cloud space at all (hasCloud false) that is Records (Contacts included), flows and Kits, the planner (reminders, notes, tasks) and the
 * calendar. A person who is in any Cloud space has the planner, reminders, notes, to-dos and the calendar in Personal too: those are kept encrypted on the team's server (CHAT 5 Oct 04:45Z, option B).
 * Custom Records, Customize, flows and Kits stay gated either way.
 * @param {string} path @param {boolean} [hasCloud]
 */
export function gatedPath(path, hasCloud = false) {
  if (/^\/u\/(records|record|flows|flow|kits|kit|settings\/customize)(\/|$)/.test(path)) {
    // Reminders and notes are the planner's own Records types: open to a person who has a Cloud space.
    if (hasCloud && /^\/u\/records\/(reminder|note)(\/|$)/.test(path)) return false;
    return true;
  }
  if (/^\/u\/(planner|calendar|task)(\/|$)/.test(path)) return !hasCloud;
  return false;
}

/** Where a Personal space's planner items are kept: encrypted on the team server of a Cloud space the person is in. @param {{ basic: boolean, teams: readonly { name: string }[] }} o */
export function storedLine({ basic, teams }) {
  if (!basic || !teams.length) return null;
  return `Reminders, notes and to-dos: encrypted on ${teams[0].name}'s server`;
}

/**
 * The backup line for a Personal (no server) space. The box says where it goes (memory.backup.status: { to: <space name or null>, last, state }). With no answer and no team space it is "Not backed up";
 * with no answer and a team space the box has not said, so nothing is claimed.
 * @param {{ basic: boolean, teams: readonly { name: string }[], status?: { to?: string | null, last?: number | string | null, state?: string } | null }} o
 */
export function backupLine({ basic, teams, status }) {
  if (!basic) return null;
  if (status && typeof status.to === "string" && status.to) return `Backed up, encrypted, to ${status.to}`;
  if (status && status.to === null) return "Not backed up: join a team or set up My Cloud";
  if (!teams.length) return "Not backed up: join a team or set up My Cloud";
  return null;
}
