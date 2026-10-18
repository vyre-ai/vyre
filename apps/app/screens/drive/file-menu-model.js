// @ts-check
// The right-click menu of Files: which actions an item (or a selection) offers, and the shortcut hint of each. Only what the item's source really does: the Space's Drive and a linked folder move, rename and
// delete; the Space shares a link; a box share is read-only (open, look, download). One item or several: a selection offers the acts that make sense on many (Ask, Move, Download, Delete), never Rename.

/** @typedef {{ root: string, dir: boolean, link?: string }} Row */
/** @typedef {{ id: string, label: string, hint?: string, danger?: boolean }} Item */

/** What a source does with a file. @param {string} root */
export function caps(root) {
  const space = root === "space", linked = root === "linked", box = root === "box";
  return { move: space || linked, rename: space || linked, remove: space || linked, share: space, download: space || linked, versions: space, duplicate: space, ask: space || linked, look: space || linked || box };
}

/**
 * The menu groups for the rows the person acted on.
 * @param {readonly Row[]} rows @returns {Item[][]}
 */
export function fileMenu(rows) {
  if (!rows.length) return [];
  const one = rows.length === 1, r = rows[0];
  const every = (/** @type {(c: ReturnType<typeof caps>, x: Row) => boolean} */ f) => rows.every((x) => f(caps(x.root), x));
  const files = rows.filter((x) => !x.dir);
  /** @type {Item[][]} */ const groups = [];
  const open = [];
  if (one) open.push({ id: "open", label: r.dir ? "Open" : "Details", hint: "Enter" });
  if (one && !r.dir && caps(r.root).look) open.push({ id: "look", label: "Quick Look", hint: "Space" });
  if (files.length && files.every((x) => caps(x.root).ask)) open.push({ id: "ask", label: one ? "Ask about this" : `Ask about these ${files.length}` });
  if (open.length) groups.push(open);
  const send = [];
  if (one && !r.dir && caps(r.root).share) send.push({ id: "share", label: "Share a link" });
  if (files.length && files.every((x) => caps(x.root).download)) send.push({ id: "download", label: "Download", hint: "⌘D" });
  if (one && !r.dir && caps(r.root).versions) send.push({ id: "versions", label: "Version history" });
  if (send.length) groups.push(send);
  const edit = [];
  if (every((c) => c.move)) edit.push({ id: "move", label: "Move to…" });
  if (one && every((c) => c.rename)) edit.push({ id: "rename", label: "Rename", hint: "Enter" });
  if (one && !r.dir && caps(r.root).duplicate) edit.push({ id: "duplicate", label: "Duplicate", hint: "⌘J" });
  if (edit.length) groups.push(edit);
  if (every((c) => c.remove)) groups.push([{ id: "delete", label: one ? "Delete" : `Delete ${rows.length} items`, danger: true, hint: "⌫" }]);
  return groups;
}

/** The rows a right-click acts on: the whole selection when the clicked row is in it, else just that row (and the selection becomes it). @param {ReadonlySet<string>} selected @param {string} clicked @returns {{ keys: string[], reselect: boolean }} */
export function actOn(selected, clicked) {
  return selected.has(clicked) ? { keys: [...selected], reselect: false } : { keys: [clicked], reselect: true };
}

/** A copy's name: "brief.pdf" becomes "brief copy.pdf", then "brief copy 2.pdf" while that is taken. @param {string} name @param {ReadonlySet<string>} taken */
export function copyName(name, taken) {
  const i = name.lastIndexOf("."), stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : "";
  let n = `${stem} copy${ext}`;
  for (let k = 2; taken.has(n); k++) n = `${stem} copy ${k}${ext}`;
  return n;
}

/** The box a drag on empty space draws, as the keys of the rows it touches. `rects`: each row's rectangle by key. @param {{ x1: number, y1: number, x2: number, y2: number }} box @param {Record<string, { left: number, top: number, right: number, bottom: number }>} rects @returns {string[]} */
export function boxSelect(box, rects) {
  const l = Math.min(box.x1, box.x2), r = Math.max(box.x1, box.x2), t = Math.min(box.y1, box.y2), b = Math.max(box.y1, box.y2);
  return Object.entries(rects).filter(([, q]) => q.left < r && q.right > l && q.top < b && q.bottom > t).map(([k]) => k);
}
