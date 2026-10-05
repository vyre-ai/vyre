// @ts-check
// Settings > Network > VyreDrive, the words without the DOM (deck/views/settings.js draws them).
//
// files.drive.status gives each share its own `access` ("ro" or "rw"); a box with one global
// `access` for them all is read the same way, so a share that does not say takes that.

/** @typedef {"ro"|"rw"} Access */

/**
 * One share's access: its own, else the box's global one, else read only.
 * @param {any} share a row of files.drive.status shares @param {any} [d] the whole answer
 * @returns {Access}
 */
export function shareAccess(share, d) {
  const own = share && share.access;
  if (own === "rw" || own === "ro") return own;
  return d && d.access === "rw" ? "rw" : "ro";
}

/** @param {Access} a */
export const accessWord = a => (a === "rw" ? "Read and write" : "Read only");
