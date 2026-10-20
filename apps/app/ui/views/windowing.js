// @ts-check
// A long list draws its first rows and a "Show more" for the rest (the table, the phone list, a board column, the gallery): a type of thousands of records mounts a page of
// rows, not thousands of views. Sorting, filters, counts and search still work on every row; only what is drawn is cut.

/** How many rows a list draws before "Show more", and how many each press adds. */
export const WINDOW = 100;

/**
 * The rows to draw and what is left. @template T @param {T[]} rows @param {number} [limit]
 * @returns {{ rows: T[], more: number, label: string }}
 */
export function windowOf(rows, limit = WINDOW) {
  const all = Array.isArray(rows) ? rows : [];
  const n = Math.max(0, Math.floor(limit));
  const more = Math.max(0, all.length - n);
  return { rows: more ? all.slice(0, n) : all, more, label: more ? `Show ${Math.min(more, WINDOW)} more` : "" };
}
