// @ts-check
// previews/access: who may open a preview. Pure: the caller works out who the person is (their id and their role in this Space) and, for a project preview, who the project's people are, and hands them in.
//   me       only the person who made it
//   project  the people of the preview's project: its owner, its team's people, the people of its chats (core/work work.project.people). A Personal project is its person's alone. Not the whole Space.
//   team     every member of the Space
// The Space's owner and admins can always open and manage what is in their Space, except a `me` preview, which is private to its maker, and a preview of someone's Personal project. `public` (anyone with the
// link) is not an access level here: it goes through Publish, with one yes (previews.share).

export const ACCESS = /** @type {const} */ (["me", "project", "team"]);

/** @typedef {{ id: string, role: "owner"|"admin"|"member"|"viewer"|string|null }} Who */
/** @typedef {{ people: string[], personal_of: string | null, missing?: boolean }} Project the people of the preview's project, for a preview whose access is `project` */

/** @param {{ access: string, created_by: string | null }} row @param {Who | null} who @param {Project | null} [project] */
export function mayOpen(row, who, project = null) {
  if (!who || !who.id) return false;
  if (row.access === "me") return row.created_by === who.id;
  if (row.access === "project") return Boolean(who.role) && Boolean(project) && !project?.missing && project?.people.includes(who.id) === true;
  if (row.access === "team") return Boolean(who.role);
  return false;
}

/** Stopping, restarting, sharing and removing: the maker, and the Space's owner and admins (never for a `me` preview that is someone else's, nor for another person's Personal project). @param {{ access: string, created_by: string | null }} row @param {Who | null} who @param {Project | null} [project] */
export function mayManage(row, who, project = null) {
  if (!who || !who.id) return false;
  if (row.created_by === who.id) return true;
  if (row.access === "me") return false;
  if (row.access === "project" && project && project.personal_of && project.personal_of !== who.id) return false;
  return who.role === "owner" || who.role === "admin";
}
