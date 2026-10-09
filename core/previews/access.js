// @ts-check
// previews/access: who may open a preview. Pure: the caller works out who the person is (their id and their role in this Space) and hands it in.
//   me       only the person who made it
//   project  everyone in the Space the project belongs to (a project has no people list of its own yet; its people are the Space's members)
//   team     every member of the Space
// The Space's owner and admins can always open and manage what is in their Space, except a `me` preview, which is private to its maker. `public` (anyone with the link) waits for the public ingress (0.3.2).

export const ACCESS = /** @type {const} */ (["me", "project", "team"]);

/** @typedef {{ id: string, role: "owner"|"admin"|"member"|"viewer"|string|null }} Who */

/** @param {{ access: string, created_by: string | null }} row @param {Who | null} who */
export function mayOpen(row, who) {
  if (!who || !who.id) return false;
  if (row.access === "me") return row.created_by === who.id;
  if (row.access === "project" || row.access === "team") return Boolean(who.role);
  return false;
}

/** Stopping, restarting, sharing and removing: the maker, and the Space's owner and admins (never for a `me` preview that is someone else's). @param {{ access: string, created_by: string | null }} row @param {Who | null} who */
export function mayManage(row, who) {
  if (!who || !who.id) return false;
  if (row.created_by === who.id) return true;
  if (row.access === "me") return false;
  return who.role === "owner" || who.role === "admin";
}
