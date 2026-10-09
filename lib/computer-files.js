// @ts-check
// Which files Vyre Computer may find or bring from a Mac for the box (R031-90, ruling 4): the person's Downloads, Desktop and Documents, nothing else. The Mac's files guard still applies on top
// (the folders the person chose for Vyre, no dotfiles, no secrets, no symlink out); this is the narrower rule for a box asking.

import path from "node:path";

/** The folders a box may find files in, below the person's home. */
export const FOLDERS = Object.freeze(["Downloads", "Desktop", "Documents"]);

/** The most a file brought to the box may weigh. */
export const MAX_BYTES = 8 * 1024 * 1024;

/** Is this path inside one of the folders? Absolute, no `..` after it is resolved. @param {unknown} p @param {string} home */
export function allowed(p, home) {
  if (typeof p !== "string" || !p || p.includes("\0") || !path.isAbsolute(p)) return false;
  const r = path.resolve(p);
  return FOLDERS.some(f => { const d = path.join(home, f); return r === d || r.startsWith(d + path.sep); });
}

/** Search results cut to the folders. @param {any[]} results @param {string} home */
export const only = (results, home) => (Array.isArray(results) ? results.filter(r => r && allowed(r.path, home)) : []);

/** A name safe to save under on the box: the file's own name, nothing that climbs. @param {string} p */
export const saveName = p => path.basename(String(p)).replace(/[\\/\0]/g, "").replace(/^\.+/, "") || "file";
