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

/**
 * The calls one move, rename or delete makes for a row, and the calls that undo it. `kind` is move (into a folder), rename (a new last part) or delete. Space rows use files.drive.space.*; linked rows use
 * the linked-folder tools. A delete of a Space row is undone by putting the version before the delete back; a linked delete is the source's own trash and has no undo here.
 * @param {"move" | "rename" | "delete"} kind @param {{ root: string, path: string, name: string, link?: string }} r @param {string} to the folder (move) or the new name (rename)
 * @returns {{ call: { tool: string, input: Record<string, unknown> }, undo: { tool: string, input: Record<string, unknown> } | null } | null}
 */
export function editCalls(kind, r, to) {
  const clean = to.trim().replace(/^\/+|\/+$/g, "");
  const up = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : "";
  if (r.root === "space") {
    if (kind === "delete") return { call: { tool: "files.drive.space.delete", input: { path: r.path } }, undo: null };
    if (kind === "rename") return { call: { tool: "files.drive.space.rename", input: { path: r.path, name: clean } }, undo: { tool: "files.drive.space.rename", input: { path: `${up}${clean}`, name: r.name } } };
    const dest = clean ? `${clean}/${r.name}` : r.name;
    return { call: { tool: "files.drive.space.move", input: { from: r.path, to: dest } }, undo: { tool: "files.drive.space.move", input: { from: dest, to: r.path } } };
  }
  if (r.root === "linked" && r.link) {
    if (kind === "delete") return { call: { tool: "files.linked.delete", input: { id: r.link, path: r.path } }, undo: null };
    if (kind === "rename") return { call: { tool: "files.linked.rename", input: { id: r.link, path: r.path, to: `${up}${clean}` } }, undo: { tool: "files.linked.rename", input: { id: r.link, path: `${up}${clean}`, to: r.path } } };
    const dest = clean ? `${clean}/${r.name}` : r.name;
    return { call: { tool: "files.linked.rename", input: { id: r.link, path: r.path, to: dest } }, undo: { tool: "files.linked.rename", input: { id: r.link, path: dest, to: r.path } } };
  }
  return null;
}

/**
 * The folder picker for "Move to...": the folders listed at the place being browsed, minus the ones that cannot take what is moved (a moved folder itself or anything inside it, and the folder it is already in
 * as a target of no change), as picker rows; plus the way up.
 * @param {readonly { dir: boolean, path: string, name: string }[]} listed what the place holds @param {readonly { path: string, dir: boolean }[]} moving @param {string} here the folder being browsed ("" for the top)
 * @returns {{ folders: { name: string, path: string }[], up: string | null, here: string, hereOk: boolean }}
 */
export function pickerView(listed, moving, here) {
  const inside = (/** @type {string} */ p) => moving.some((m) => m.dir && (p === m.path || p.startsWith(`${m.path}/`)));
  const folders = listed.filter((x) => x.dir && !inside(x.path)).map((x) => ({ name: x.name, path: x.path })).sort((a, b) => a.name.localeCompare(b.name));
  const up = here ? (here.includes("/") ? here.slice(0, here.lastIndexOf("/")) : "") : null;
  const parents = new Set(moving.map((m) => (m.path.includes("/") ? m.path.slice(0, m.path.lastIndexOf("/")) : "")));
  return { folders, up, here, hereOk: !inside(here) && !(parents.size === 1 && parents.has(here)) };
}

/** What a drag of rows carries and where it can drop: dropping on one of the dragged rows themselves, or a folder inside a dragged folder, is no move. @param {readonly string[]} dragged keys @param {string} overKey @param {readonly { key: string, dir: boolean, path: string }[]} rows */
export function dragMoveTarget(dragged, overKey, rows) {
  const over = rows.find((r) => r.key === overKey);
  if (!over || !over.dir || dragged.includes(overKey)) return null;
  const moving = rows.filter((r) => dragged.includes(r.key));
  if (moving.some((m) => m.dir && (over.path === m.path || over.path.startsWith(`${m.path}/`)))) return null;
  return over;
}
