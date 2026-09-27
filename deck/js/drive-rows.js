// @ts-check
// Settings > Network > VyreDrive, the words without the DOM (deck/views/settings.js draws them).
//
// files.drive.status gives each share its own `access` ("ro" or "rw") on a box with
// files.drive.access; an older box has one global `access` for them all, so a share that does
// not say takes that. files.drive.audit (and the drive.exposed event) may carry `unsafe`: the
// shared folders that hold secrets now, or could not be checked. files.drive.access answers
// { name, access, mount: { want, now, change, step? } }: when the box's mount has to change,
// the step says how.

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

/** The other mode, for the switch. @param {Access} a @returns {Access} */
export const flip = a => (a === "rw" ? "ro" : "rw");

/** Does any share on this box say its own access (a box with files.drive.access)? @param {any[]} shares */
export const perShare = shares => (Array.isArray(shares) ? shares : []).some(s => s && (s.access === "ro" || s.access === "rw"));

/**
 * The warning lines for shares with secrets inside, from files.drive.audit or drive.exposed.
 * An old box has no `unsafe`: no lines.
 * @param {any} a
 * @returns {{ share: string, text: string }[]}
 */
export function unsafeLines(a) {
  const list = a && Array.isArray(a.unsafe) ? a.unsafe : [];
  return list.filter(u => u && u.share).map(u => {
    const share = String(u.share);
    const found = Array.isArray(u.found) ? u.found.map(String).filter(Boolean) : [];
    if (u.why) return { share, text: `${share} could not be checked for secrets: ${u.why}${found.length ? `. Found so far: ${found.join(", ")}` : ""}.` };
    return { share, text: `${share} has secrets inside: ${found.length ? found.join(", ") : "files that look like keys"}` };
  });
}

/**
 * What files.drive.access's answer asks of the person: nothing, or the remount line and, when
 * the box says it, the step to run first.
 * @param {any} r
 * @returns {{ line: string, step: string|null } | null}
 */
export function mountHint(r) {
  const m = r && r.mount;
  if (!m || m.change !== true) return null;
  return { line: "Remount on your Mac", step: typeof m.step === "string" && m.step ? m.step : null };
}
