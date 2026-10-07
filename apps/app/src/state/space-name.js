// @ts-check
// The one function that names a space, used by every screen that shows one (the switcher, Settings, Find, Devices, Spaces, Install, tasks): the user's names (CHAT 5 Oct 03:30Z). A personal space with no
// server (the box's tier "basic") is "Personal"; a personal space on the person's own server (tier "cloud") is "My Cloud"; a team space is called by its own name (the name the person gave it, else its
// label, else its address without ".vyre.run"). A team space with no readable name is "Space" and the gap is logged. Never an id, and never "Basic" or "Pro".

/** @typedef {{ id?: string, name?: string, label?: string, displayName?: string, tier?: string, who?: string, setup?: { who?: string, picks?: { who?: string } } | null }} SpaceNameRow */

const idLike = (/** @type {unknown} */ v) => typeof v === "string" && /^spc_/i.test(v.trim());
const nameable = (/** @type {unknown} */ v) => (typeof v === "string" && v.trim() && !idLike(v) ? v.trim().replace(/\.vyre\.run$/i, "") : "");

/** @param {SpaceNameRow} s */
export const isPersonal = (s) => s.who === "personal" || s.setup?.who === "personal" || s.setup?.picks?.who === "personal";

/** @param {SpaceNameRow} s @returns {string} */
export function spaceName(s) {
  if (s.tier === "basic") return "Personal";
  if (isPersonal(s) && s.tier === "cloud") return "My Cloud";
  const n = nameable(s.displayName) || nameable(s.label) || nameable(s.name);
  if (n) return n;
  if (isPersonal(s)) return "Personal";
  console.warn(`space ${s.id} has no readable name (displayName, label and name are empty or ids); showing "Space"`);
  return "Space";
}
