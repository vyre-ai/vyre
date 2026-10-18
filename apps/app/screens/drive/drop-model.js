// @ts-check
// Dropping files on Files: where they go and what the screen says. Pure: the screen asks `dropTarget` for the folder a drop lands in (the row under the pointer if it is a folder that takes files, else the folder
// open), `canDrop` for whether that place takes uploads at all, and `plan` for which of the dropped files go and which are left with a word. The size cap and the name rule are the Upload button's own (MAX_UPLOAD).

/** @typedef {{ place: string, root: string, path: string, link?: string }} Folder */

/** Whether a place takes uploaded files: the Space's Drive and a linked folder (a folder inside one), nothing else. @param {{ root: string, link?: string }} p */
export const canDrop = (p) => p.root === "space" || (p.root === "linked" && Boolean(p.link));

/**
 * The folder a drop lands in. `over` is the folder row the pointer is on (if any); a row that is not a folder, or a folder that takes no files, falls back to the open folder. null: nothing takes it.
 * @param {Folder | null} open @param {(Folder & { dir: boolean }) | null} over @returns {Folder | null}
 */
export function dropTarget(open, over) {
  if (over && over.dir && canDrop(over)) return over;
  return open && canDrop(open) ? open : null;
}

/** The words over the highlight. @param {Folder | null} target @param {(f: Folder) => string} nameOf */
export const dropWords = (target, nameOf) => (target ? `Drop to upload to ${nameOf(target)}` : "Files cannot be dropped here");

/** Whether a drag carries files from outside the page (not text or a row of this list being dragged). @param {{ types?: readonly string[] | DOMStringList | null } | null | undefined} dt */
export const carriesFiles = (dt) => Boolean(dt && dt.types && Array.prototype.includes.call(dt.types, "Files"));

/**
 * Which dropped files go: a folder dropped (no type, no size) is left out, a file over the cap is left out with the Upload button's words.
 * @param {readonly { name: string, size: number, type?: string }[]} files @param {number} max
 * @returns {{ go: { name: string, size: number }[], skipped: { name: string, why: "too_large" | "not_a_file" }[] }}
 */
export function plan(files, max) {
  const go = [], skipped = [];
  for (const f of files) {
    if (!f.name || (f.size === 0 && !f.type)) skipped.push({ name: f.name || "?", why: /** @type {const} */ ("not_a_file") });
    else if (f.size > max) skipped.push({ name: f.name, why: /** @type {const} */ ("too_large") });
    else go.push(f);
  }
  return { go, skipped };
}

/** The toast line while files go up: "Uploading 2 of 5: name". @param {number} done @param {number} total @param {string} name */
export const progressLine = (done, total, name) => (total === 1 ? `Uploading ${name}` : `Uploading ${done + 1} of ${total}: ${name}`);
