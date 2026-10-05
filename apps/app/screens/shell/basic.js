// @ts-check
// A Basic personal space is one with no server (CHAT 5 Oct 03:15Z): chats and projects work as normal, but Planner, tasks, reminders, notes, Records and flows need a space on a server. On Basic those places
// say one plain line, offer the team spaces the person is in, and offer a server of their own. This file is the pure part: which space is Basic, which places are gated, and the backup line.

export const NEEDS_SERVER = "This needs a space on a server";
export const ADD_SERVER = "Add your own server";

/** Is this space row a Basic personal space: the person's own, and not on a server? @param {{ home?: { kind?: string } | null, who?: string, setup?: { who?: string, picks?: { who?: string } } | null } | null | undefined} row */
export function isBasicRow(row) {
  if (!row) return false;
  const personal = row.who === "personal" || row.setup?.who === "personal" || row.setup?.picks?.who === "personal";
  return personal && row.home?.kind !== "server";
}

/** The places that need a server: Records (Contacts included), flows and kits, the planner (reminders, notes, tasks) and the calendar, which is Records. @param {string} path */
export const gatedPath = (path) => /^\/u\/(records|record|flows|flow|kits|kit|planner|calendar|task|settings\/customize)(\/|$)/.test(path);

/** Where a backup of this Basic space goes: the team spaces the person is in (an encrypted copy on a server they belong to), or nowhere. @param {{ basic: boolean, teams: readonly { name: string }[], status?: { to?: string } | null }} o */
export function backupLine({ basic, teams, status }) {
  if (!basic) return null;
  if (status && typeof status.to === "string" && status.to) return `Backed up, encrypted, to ${status.to}`;
  if (!teams.length) return "Not backed up: join a team or add a server";
  return null;
}
