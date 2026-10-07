// @ts-check
// What the box answers for Spaces and members, as the screen's own types. Pure, so Node tests it with the real answer shapes
// (spaces.list, spaces.members.list, spaces.roles.names, projects.list on a kernel-on vyred).

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct" for an epoch in ms. */
export const dateOf = (/** @type {number} */ ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

/** Where a space lives, in words. */
export function homeWords(/** @type {any} */ home) {
  const k = home && home.kind;
  return k === "this-computer" ? "this computer" : k === "server" || k === "vps" ? "your server" : k ? String(k) : "an unknown home";
}

import { spaceName } from "../../src/state/space-name.js";

/** @param {any} data spaces.list: an array, only spaces that have their home. */
export function shapeSpaces(data) {
  if (!Array.isArray(data)) return [];
  return data.filter((s) => s && typeof s.id === "string" && s.status !== "failed" && s.status !== "cancelled").map((s) => ({
    id: s.id,
    // the same name the switcher shows: Personal, My Cloud, or the team's own name (never an id)
    name: spaceName(s),
    address: s.name,
    zone: typeof s.time_zone === "string" && s.time_zone ? s.time_zone : null,
    role: s.role === "owner" ? "owner" : s.role || "member",
    home: homeWords(s.home),
    setup: s.setup || null,
  }));
}

/** The kernel's own names for the roles: { owner: "Owner", ... }. */
export function roleNames(/** @type {any} */ data) {
  /** @type {Record<string, string>} */ const out = {};
  for (const r of (data && data.names) || []) if (r && r.id) out[r.id] = r.name;
  return out;
}

/** A person's line: "You" for the signed-in identity, otherwise a short form of the id (the box keeps no display name for a member). */
export function personName(/** @type {string} */ id, /** @type {string | null} */ self) {
  if (id === self) return "You";
  return id.startsWith("per_") ? `Member ${id.slice(4, 10)}` : id;
}

/** Whole days left until `expires` (never below 0), or undefined. */
export const daysLeft = (/** @type {number | null | undefined} */ expires, /** @type {number} */ now) => (typeof expires === "number" ? Math.max(0, Math.ceil((expires - now) / DAY)) : undefined);

/** @param {any} data spaces.members.list @param {string | null} self @param {number} now @param {Record<string, string>} [projects] id to name */
export function shapeMembers(data, self, now, projects = {}) {
  const list = (data && data.members) || [];
  return list.filter((/** @type {any} */ m) => m && typeof m.person === "string").map((/** @type {any} */ m) => {
    const scope = Array.isArray(m.scope) && m.scope.length ? m.scope.map((/** @type {string} */ p) => projects[p] || p).join(", ") : undefined;
    return {
      id: m.person,
      name: personName(m.person, self),
      role: m.role,
      ...(m.role === "temp" ? { scope, end: typeof m.expires === "number" ? dateOf(m.expires) : undefined, left: daysLeft(m.expires, now) } : {}),
    };
  });
}

/** The warning lines the box sends with a member list, as words. */
export const warningLines = (/** @type {any} */ data) => (((data && data.warnings) || []).map((/** @type {any} */ w) => w.message).filter(Boolean));

/** @param {any} data projects.list */
export function shapeProjects(data) {
  /** @type {{ id: string, name: string }[]} */ const out = [];
  for (const p of (data && data.projects) || []) if (p && typeof p.id === "string") out.push({ id: p.id, name: p.name || p.title || p.id });
  return out;
}

/** The end date a number of days from now, in ms. */
export const expiresIn = (/** @type {number} */ days, /** @type {number} */ now) => now + days * DAY;

/** Extending a temp member by days: from the later of now and their current end. */
export const extendedTo = (/** @type {number | null | undefined} */ current, /** @type {number} */ days, /** @type {number} */ now) => Math.max(now, current || 0) + days * DAY;

/** Inputs for the writes, as the box takes them. */
export const setRoleInput = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ role, /** @type {{ scope?: string[], days?: number }} */ o, /** @type {number} */ now) =>
  ({ space, person, role, ...(role === "temp" ? { scope: o.scope ?? [], expires: expiresIn(o.days ?? 7, now) } : {}) });
