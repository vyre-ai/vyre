// @ts-check
// The pure half of the Backups screen (spaces.bundle.status): the plain line for each Space, and when it was last backed up.

/** @typedef {{ space: string, name: string, home: boolean, enrolled: boolean, last: number | null, note?: string }} SpaceBackup */

/** One plain line under a Space's name. @param {SpaceBackup} r */
export const backupLine = r => (r.enrolled ? "Backed up with this box's backups" : r.note || (r.home ? "Your own Space isn't backed up yet: turn on backups with your recovery code." : `Space ${r.name} isn't backed up: its owner hasn't turned on backups.`));

/** When the bundle was last written, in a few words. @param {number | null} last @param {number} [now] */
export function whenLine(last, now = Date.now()) {
  if (!last) return "Waiting for the first backup";
  const m = Math.max(0, Math.round((now - last) / 60000));
  return m < 2 ? "Just now" : m < 60 ? `${m} minutes ago` : m < 1440 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}
