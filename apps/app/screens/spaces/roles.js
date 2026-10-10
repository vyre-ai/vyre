// @ts-check
// Roles in a space (DESIGN-spaces-first.md): five fixed names, tied to identity. Pure, so Node tests it.

import { ROLE_IDS, ROLE_RANK, ROLE_LABELS } from "../../../../kernel/contracts/index.js";

/** @typedef {"owner"|"admin"|"manager"|"member"|"temp"} Role */

/** @type {Record<Role, string>} */
const LINES = {
  owner: "Everything, including deleting, moving or handing over the space.",
  admin: "Members, devices, Customize, connectors and assistants. Cannot delete or move the space.",
  manager: "Creates and runs projects, sets teams and tasks. Cannot change types or manage members.",
  member: "Works on the projects they belong to.",
  temp: "Only the projects named, until an end date.",
};
export const ROLES = ROLE_IDS.map((id) => ({ id, label: ROLE_LABELS[id], line: LINES[id] }));

const RANK = ROLE_RANK;

/** The Vyre name of a role; a Kit role has none here, so its own name. */
export const roleLabel = (/** @type {string} */ r) => (Object.hasOwn(ROLE_LABELS, r) ? /** @type {any} */ (ROLE_LABELS)[r] : r);

/**
 * The roles `actor` may give from the app. An owner can give any but Owner; an admin can give roles below admin; nobody else can change roles.
 * Owner is never given here: a server that has an owner is moved on the server itself, with the person's passkey (wink.server.adopt refuses the
 * paired app's call with presence_required). See `ownerMoveLine`.
 */
export function assignable(/** @type {Role} */ actor) {
  if (actor === "owner") return ROLES.filter((r) => r.id !== "owner").map((r) => r.id);
  if (actor === "admin") return ROLES.filter((r) => RANK[r.id] < RANK.admin).map((r) => r.id);
  return [];
}

/** Can `actor` change or remove `target`? Never yourself here, and never someone at or above your own rank unless you own the space. */
export function canManage(/** @type {Role} */ actor, /** @type {Role} */ target, /** @type {boolean} */ self = false) {
  if (self) return false;
  if (actor === "owner") return true;
  return actor === "admin" && RANK[target] < RANK.admin;
}

/** What the person is told when they ask to change a server's owner from the app. The move happens on the server, approved with their own passkey. */
export const ownerMoveLine = (/** @type {string} */ owner) => `This server already belongs to ${owner}. To move it, do it on this server and approve with your passkey.`;

export const TEMP_ENDS = [["7", "1 week"], ["30", "30 days"], ["90", "3 months"]];
export const EXTENSIONS = [["7", "One more week"], ["30", "30 more days"], ["90", "Three more months"]];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct": the date `days` after `from`. */
export function endDate(/** @type {number} */ days, /** @type {Date} */ from = new Date(2026, 9, 3)) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A temp member's line: "Only Doe estate plan, ends 14 Oct (11 days)". */
export function tempLine(/** @type {{ scope?: string, end?: string, left?: number }} */ m) {
  return `Only ${m.scope}, ends ${m.end} (${m.left} ${m.left === 1 ? "day" : "days"})`;
}

/** Temp access ending within three days gets a primary Extend. */
export const endingSoon = (/** @type {{ role: Role, left?: number }} */ m) => m.role === "temp" && (m.left ?? 99) <= 3;

/** One tap extends a temp member: a grant change made with presence, so the caller asks for Face ID first. */
export function extend(/** @type {{ left?: number }} */ m, /** @type {number} */ days, /** @type {Date} */ from = new Date(2026, 9, 3)) {
  const left = (m.left ?? 0) + days;
  return { ...m, left, end: endDate(left, from) };
}

/** The member after a role change: a temp needs a scope and an end, everyone else has none. */
export function withRole(/** @type {any} */ m, /** @type {Role} */ role, /** @type {{ scope?: string, days?: number }} */ opts = {}) {
  if (role !== "temp") { const { scope, end, left, ...rest } = m; return { ...rest, role }; }
  const days = opts.days ?? m.left ?? 7;
  return { ...m, role, scope: opts.scope ?? m.scope, left: days, end: endDate(days) };
}

/**
 * The people of a space as rows of a list block: the face (seeded by the person's id), the role, or for a temp member the project and when it ends, and Extend for a temp member you may manage.
 * `team` are the mock build's teammates. @param {{ id: string, name: string, role: string, scope?: string, end?: string }[]} members @param {(m: any) => boolean} can @param {{ id: string, name: string, sub: string }[]} [team]
 */
export function memberRows(members, can, team = []) {
  return [
    ...members.map((m) => {
      const temp = m.role === "temp";
      return { id: m.id, title: m.name, subtitle: temp ? `Temp, ends ${m.end} · Only ${m.scope}` : roleLabel(/** @type {any} */ (m.role)), faces: [{ kind: "person", name: m.name, id: m.id }],
        ...(temp && can(m) ? { actions: [{ id: "extend", title: "Extend" }] } : {}) };
    }),
    ...team.map((t) => ({ id: t.id, title: t.name, subtitle: t.sub, faces: [{ kind: t.id === "juno" || t.name === "juno" ? "assistant" : "teammate", name: t.name, id: t.id }] })),
  ];
}
