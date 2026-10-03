// Drive, as pure functions: files per space and project, versions, shared links (Face ID, 7 days, sealed files cannot be shared), the mounted drive.

export const LINK_DAYS = 7;

/** @typedef {{ id: string, sp: string, proj: string, name: string, ver: number, mod: string, by: string, att?: { id: string, title: string }, size: string, sealed?: boolean, note?: string }} File */

/** @template {{ sp: string, proj: string }} T @param {T[]} files @param {string} scope @param {string} proj */
export const filesIn = (files, scope, proj) => files.filter((f) => (scope === "all" || f.sp === scope) && (proj === "all" || f.proj === proj));

/** The projects that have a file in the spaces in view. @param {File[]} files @param {string} scope */
export const projectsIn = (files, scope) => [...new Set(files.filter((f) => scope === "all" || f.sp === scope).map((f) => f.proj))];

/** Newest first. Each older version can be restored, which makes a new version and keeps the history. @param {File} f @param {string[]} editors */
export function versionsOf(f, editors) {
  /** @type {{ n: number, current: boolean, line: string }[]} */
  const out = [];
  for (let n = f.ver; n >= 1; n--) {
    const who = editors[n % editors.length];
    out.push({ n, current: n === f.ver, line: n === f.ver ? `${f.mod} by ${f.by} (current)` : n === 1 ? `Created by ${f.by}` : `Edited by ${who}, ${f.ver - n + 1} days earlier` });
  }
  return out;
}

/** Restoring version n adds a new version on top. @template {{ id: string, ver: number, mod: string }} T @param {T[]} files @param {string} id @param {number} n */
export const restore = (files, id, n) => files.map((f) => (f.id === id && n < f.ver ? { ...f, ver: f.ver + 1, mod: "Just now" } : f));

/** A sealed file cannot be shared as a link; everything else can, after Face ID. @param {File} f */
export const canShare = (/** @type {{ sealed?: boolean }} */ f) => !f.sealed;

/** A new link for a file. The code is derived from the file and how many links exist, so it is the same on a repeat render. @param {{ id: string, file: string, name: string, code: string }[]} links @param {{ id: string, name: string, sealed?: boolean }} f */
export function addLink(links, f) {
  if (!canShare(f)) return links;
  const code = `${f.id}${(links.length + 1).toString(36)}${f.name.length.toString(36)}`.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  return [...links, { id: `l${links.length + 1}`, file: f.id, name: f.name, code }];
}

/** @template {{ id: string }} T @param {T[]} links @param {string} id */
export const revoke = (links, id) => links.filter((l) => l.id !== id);
