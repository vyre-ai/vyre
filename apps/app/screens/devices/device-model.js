// @ts-check
// A device's spaces on the real box (UX-17, UX-18): spaces.devices.list rows as the lines the Device screen shows, and the words for each refusal. Pure.

/** @typedef {{ space: string, name?: string, label?: string, displayName?: string, role?: string, enrolled?: boolean, removed?: boolean, lent?: boolean }} SpaceRow */

/** The name a person knows a space by. @param {SpaceRow} r */
export const spaceTitle = (r) => r.displayName || r.label || r.name || r.space;

/** Spaces the device is in now, and spaces it is not (removed or never enrolled). @param {SpaceRow[]} rows */
export function split(rows) {
  const inIt = rows.filter((r) => r.enrolled && !r.removed);
  return { inIt, notIn: rows.filter((r) => !(r.enrolled && !r.removed)) };
}

/** Words under a space's name. @param {SpaceRow} r @param {string} device */
export const rowLine = (r, device) => (r.enrolled && !r.removed ? `Reaches ${spaceTitle(r)} on its own.${r.lent ? ` Shared with ${spaceTitle(r)}.` : ""}` : r.removed ? "Removed. Add it again from another of your devices." : "Not enrolled");

export const removedToast = (/** @type {string} */ device, /** @type {string} */ space) => `${device} no longer reaches ${space}. Its other spaces are untouched.`;
export const REMOVE_NOTE = "Removing a device from a space stops it reaching that space now. Its other spaces and your name are untouched.";
export const lentToast = (/** @type {boolean} */ on, /** @type {string} */ device, /** @type {string} */ space) => (on ? `${space} may use ${device} when it is idle.` : `Stopped sharing ${device} with ${space}.`);

/** @param {string | undefined} code @param {string} message */
export function deviceRefusal(code, message) {
  if (code === "not_a_member") return "You are not a member of that space.";
  if (code === "device_removed") return "That device was already removed from the space.";
  if (code === "not_found") return "The box does not know that device.";
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  return message || "The device change did not go through.";
}
