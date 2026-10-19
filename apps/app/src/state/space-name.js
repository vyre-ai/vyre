// @ts-check
// The one function that names a space, used by every screen that shows one (the switcher, Settings, Find, Devices, Spaces, Install, tasks): the user's names (CHAT 5 Oct 03:30Z). A personal space with no
// server (the box's tier "basic": Home, only on the person's own computers) is "My Home"; a personal space on the person's own server (tier "cloud") is "My Cloud"; a team space with a server is
// "<its name>'s Cloud" ("Northwind's Cloud": the name the person gave it, else its label, else its address without ".vyre.run"); a team space with no tier says only its name. A team space with no readable name
// is "Space" and the gap is logged. Never an id, and never "Basic" or "Pro".

/** @typedef {{ id?: string, name?: string, label?: string, displayName?: string, tier?: string, who?: string, setup?: { who?: string, picks?: { who?: string } } | null }} SpaceNameRow */

const idLike = (/** @type {unknown} */ v) => typeof v === "string" && /^spc_/i.test(v.trim());
const nameable = (/** @type {unknown} */ v) => (typeof v === "string" && v.trim() && !idLike(v) ? v.trim().replace(/\.vyre\.run$/i, "") : "");

/** @param {SpaceNameRow} s */
export const isPersonal = (s) => s.label === "personal" || s.who === "personal" || s.setup?.who === "personal" || s.setup?.picks?.who === "personal";

/** @param {SpaceNameRow} s @returns {string} */
export function spaceName(s) {
  if (s.tier === "basic" && (isPersonal(s) || !nameable(s.displayName) && !nameable(s.label) && !nameable(s.name))) return "My Home";
  if (isPersonal(s) && s.tier === "cloud") return "My Cloud";
  const n = nameable(s.displayName) || nameable(s.label) || nameable(s.name);
  if (n && s.tier === "cloud" && !isPersonal(s)) return /\bcloud$/i.test(n) ? n : `${n}'s Cloud`;
  if (n) return n;
  if (isPersonal(s)) return "My Home";
  console.warn(`space ${s.id} has no readable name (displayName, label and name are empty or ids); showing "Space"`);
  return "Space";
}

/**
 * The small tag that goes on everything (12 Oct ruling): where a thing lives, in words. A personal space with no server (tier "basic") is "Personal - Home"; a personal space on her own server (tier "cloud") is
 * "Personal - Cloud"; anything that belongs to a team Space says that Space's own name ("Acme"), without the "'s Cloud" the switcher adds. One function decides it, from the space row; no screen guesses.
 * @param {SpaceNameRow} s @returns {string}
 */
export function placeTag(s) {
  if (isPersonal(s)) return s.tier === "cloud" ? "Personal - Cloud" : "Personal - Home";
  if (s.tier === "basic" && !nameable(s.displayName) && !nameable(s.label) && !nameable(s.name)) return "Personal - Home";
  const n = nameable(s.displayName) || nameable(s.label) || nameable(s.name);
  return n ? n.replace(/'s Cloud$/i, "") : "Space";
}
