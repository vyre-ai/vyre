// @ts-check
// Moving in Files, the pure half: where a set of rows may go, what the screen says when they may not, and the drag that carries them. The folder picker, the drag-to-move and the phone's "Move to..." all
// ask here. The calls themselves are file-menu-model's editCalls (files.drive.space.move; the linked-folder rename), so a move is one thing however it is started.

/** @typedef {{ root: string, path: string, name: string, dir: boolean, link?: string }} MoveRow */
/** @typedef {{ root: string, path: string, link?: string }} MoveDest */

/** The drag type a row of this list carries. A drag of files from outside the page carries "Files" instead (drop-model.js). */
export const DRAG_TYPE = "application/x-vyre-files";

/** Whether a drag carries rows of this list (to move), not files from outside the page (to upload). @param {{ types?: readonly string[] | DOMStringList | null } | null | undefined} dt */
export const carriesRows = (dt) => Boolean(dt && dt.types && Array.prototype.includes.call(dt.types, DRAG_TYPE));

/** The folder a path is in ("" for the top). @param {string} path */
export const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Whether a place takes moves: the Space's Drive, or a linked folder (inside one). @param {{ root: string, link?: string }} p */
export const takesMoves = (p) => p.root === "space" || (p.root === "linked" && Boolean(p.link));

/** Whether a row is in the same place as the folder: the Space with the Space, one linked folder with the same one. @param {MoveRow} r @param {MoveDest} d */
const samePlace = (r, d) => r.root === d.root && (r.root !== "linked" || r.link === d.link);

/**
 * Which of the rows go into the folder, and why the others stay. A row already in that folder stays without a word; a row of another place, or a folder into itself or below itself, stays with one.
 * @param {readonly MoveRow[]} rows @param {MoveDest | null} dest
 * @returns {{ go: MoveRow[], said: string }} `said` is the plain sentence to show when nothing goes ("" when something does or the rows were all there already)
 */
export function plan(rows, dest) {
  if (!rows.length) return { go: [], said: "Pick something to move." };
  if (!dest || !takesMoves(dest)) return { go: [], said: "Files move inside the Space, or inside one linked folder." };
  /** @type {MoveRow[]} */ const go = [];
  /** @type {string[]} */ const said = [];
  for (const r of rows) {
    if (!takesMoves(r) || !samePlace(r, dest)) { said.push(`${r.name} is in another place: files move inside the Space, or inside one linked folder.`); continue; }
    if (r.dir && (dest.path === r.path || dest.path.startsWith(`${r.path}/`))) { said.push(`${r.name} cannot go into itself.`); continue; }
    if (parentOf(r.path) === dest.path) continue;
    go.push(r);
  }
  return { go, said: go.length ? "" : said[0] ?? "That is already where it is." };
}

/** The line in the toast after a move. @param {number} n @param {string} where the folder's name @param {number} skipped */
export const movedLine = (n, where, skipped) => `Moved ${n === 1 ? "1 item" : `${n} items`} to ${where}.${skipped ? ` ${skipped === 1 ? "1 stayed" : `${skipped} stayed`} where ${skipped === 1 ? "it" : "they"} belong${skipped === 1 ? "s" : ""}.` : ""}`;

/** The words over a folder while rows are dragged on it. @param {readonly MoveRow[]} rows @param {string} where */
export const dragWords = (rows, where) => `Move ${rows.length === 1 ? rows[0].name : `${rows.length} items`} to ${where}`;

/**
 * The folders the picker offers at one level: the folders of a listing, without the ones being moved (a folder cannot be picked from inside itself, so it is not offered to enter either).
 * @param {readonly { name: string, path: string, dir: boolean }[]} listing @param {readonly MoveRow[]} moving
 */
export function pickable(listing, moving) {
  const gone = new Set(moving.filter((m) => m.dir).map((m) => m.path));
  return listing.filter((x) => x.dir && !gone.has(x.path));
}

/** The picker's crumbs for a stack of folders the person went into: the place first, then each folder by its name, each keyed by its path ("" for the place). @param {string} rootName @param {readonly { name: string, path: string }[]} stack */
export const pickerCrumbs = (rootName, stack) => [{ name: rootName, key: "" }, ...stack.map((s) => ({ name: s.name, key: s.path }))];
