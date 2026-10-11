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

/**
 * The two plain lines about the Vault's own automatic backup (vault.autobackup.status): the last backup and the last restore drill.
 * @param {{ enrolled: boolean, last: { at: number, items: number } | null, drill: { at: number, ok: boolean, note: string } | null, keep: number } | null | undefined} v @param {number} [now]
 * @returns {{ title: string, backup: string, drill: string, warn: boolean }}
 */
export function vaultBackupLines(v, now = Date.now()) {
  if (!v || !v.enrolled) return { title: "Vault backup", backup: "Not on. Turn it on from the computer where Vyre runs: vyre vault autobackup enrol.", drill: "", warn: true };
  const items = v.last ? `${v.last.items} ${v.last.items === 1 ? "item" : "items"}` : "";
  const backup = v.last ? `Last backup ${whenLine(v.last.at, now).toLowerCase()}, ${items}. The newest ${v.keep} are kept.` : "Turned on; the first backup is made within the hour.";
  const drill = !v.drill ? "Not tried yet: vyre vault restore --drill proves a backup restores." : v.drill.ok ? `Restore tried ${whenLine(v.drill.at, now).toLowerCase()}: it worked. ${v.drill.note}.` : `Restore tried ${whenLine(v.drill.at, now).toLowerCase()}: it did NOT match (${v.drill.note}). Make a new backup and try again.`;
  return { title: "Vault backup", backup, drill, warn: !v.last || Boolean(v.drill && !v.drill.ok) };
}
