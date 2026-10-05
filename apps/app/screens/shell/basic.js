// @ts-check
// A Basic personal space is one with no server (CHAT 5 Oct 03:15Z): chats and projects work as normal, but Planner, tasks, reminders, notes, Records and flows need a space on a server. On Basic those places
// say one plain line, offer the team spaces the person is in, and offer a server of their own. This file is the pure part: which space is Basic, which places are gated, and the backup line.

export const NEEDS_SERVER = "This needs a Cloud space";
export const ADD_SERVER = "Set up My Cloud";

/** Is this space row a personal space with no server? Read only from the box's `tier` field ("basic" or "cloud"); a team or joined space is always cloud. @param {{ tier?: string } | null | undefined} row */
export const isBasicRow = (row) => Boolean(row) && row?.tier === "basic";

/** The places that need a server: Records (Contacts included), flows and kits, the planner (reminders, notes, tasks) and the calendar, which is Records. @param {string} path */
export const gatedPath = (path) => /^\/u\/(records|record|flows|flow|kits|kit|planner|calendar|task|settings\/customize)(\/|$)/.test(path);

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
