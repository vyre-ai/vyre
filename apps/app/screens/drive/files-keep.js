// @ts-check
// Files opens from this device's last copy of a folder (the same rule as Home and Records: draw what was kept at once, read the box behind it, replace it in place). Per Space and place, the rows
// of a listing. Only names, sizes and times ride, which the caller could read anyway. Pure; the screen holds the memory and the view cache.

export const V = 1;
/** The rows of one folder kept for the next open. */
export const ROWS_KEPT = 300;
/** A copy older than this is not shown: the box is asked fresh and the loading rows show. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** How long a folder's listing may take before the screen says so and offers a retry, rather than showing loading rows for ever. */
export const LIST_MS = 20_000;
/** How long the folder names lookup (a project's folder is an id; files.places gives its name) may take: the listing never waits on it for longer. */
export const NAMES_MS = 3_000;

/** @param {string | null | undefined} space @param {string} place */
export const filesKey = (space, place) => `files.rows.${space || "home"}.${place}`;

/** @param {any[]} rows @param {number} [now] */
export const packRows = (rows, now = Date.now()) => ({ v: V, at: now, rows: rows.slice(0, ROWS_KEPT) });

/** The kept rows, or null when there is none, it is too old or it is not this shape. @param {any} raw @param {number} [now] */
export function pickRows(raw, now = Date.now()) {
  if (!raw || raw.v !== V || !Array.isArray(raw.rows) || typeof raw.at !== "number") return null;
  if (now - raw.at > MAX_AGE_MS) return null;
  return raw.rows;
}

/** What a listing that never answered says. */
export const SLOW_WORDS = "The folder did not answer in time. Check that the server is on and online, then try again.";
