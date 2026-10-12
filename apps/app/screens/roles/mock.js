// @ts-check
// The roles the sample world shows (EXPO_PUBLIC_VYRE_MOCK=1): a small firm, so the owner can click through Roles with realistic names.
import { SAMPLE_TYPES, builtInRoles, newRole, setAccess, setCan, setHidden, setTool, setWhere, setProject } from "./model.js";

export const MOCK_PROJECTS = [
  { id: "smith-estate", name: "Smith estate" },
  { id: "jones-estate", name: "Jones estate" },
  { id: "ortiz-poa", name: "Ortiz power of attorney" },
  { id: "site-rebuild", name: "Site rebuild" },
];

/** @param {import("./model.js").Role} r @param {...((r: import("./model.js").Role) => import("./model.js").Role)} edits */
const apply = (r, ...edits) => edits.reduce((x, f) => f(x), r);
const on = (/** @type {string[]} */ keys, /** @type {(r: any, k: string, v: boolean) => any} */ f) => (/** @type {any} */ r) => keys.reduce((x, k) => f(x, k, true), r);

/** The roles a firm would make, each from a built-in. @returns {import("./model.js").Role[]} */
export function sampleRoles() {
  const built = builtInRoles({ owner: 1, admin: 1, member: 1, guest: 2 }, SAMPLE_TYPES);
  const make = (/** @type {string} */ from, /** @type {string} */ name, /** @type {number} */ holders) => ({ ...newRole(from, name, built), holders });
  const partner = apply(make("admin", "Partner", 2), (r) => setCan(r, "settings", false));
  const associate = apply(make("member", "Associate", 5), on(["mail", "calendar", "documents", "files"], setTool), (r) => setHidden(r, "client", "SSN", true), (r) => setHidden(r, "project", "Fee", true), (r) => setAccess(r, "invoice", "read"), (r) => setHidden(r, "invoice", "Rate", true), (r) => setCan(r, "approve", true));
  const paralegal = apply(make("member", "Paralegal", 4), on(["calendar", "documents", "files"], setTool), (r) => setHidden(r, "client", "SSN", true), (r) => setHidden(r, "client", "Private notes", true), (r) => setAccess(r, "project", "read"), (r) => setAccess(r, "invoice", "none"), (r) => setCan(r, "create", false));
  const assistant = apply(make("member", "Assistant", 2), on(["calendar", "mail"], setTool), (r) => setWhere(r, "chosen"), (r) => setProject(r, "smith-estate", true), (r) => setProject(r, "jones-estate", true), (r) => setAccess(r, "client", "read"), (r) => setHidden(r, "client", "SSN", true), (r) => setAccess(r, "project", "read"), (r) => setAccess(r, "invoice", "none"), (r) => setAccess(r, "document", "read"), (r) => setCan(r, "create", false), (r) => setCan(r, "delete", false));
  return [...built, partner, associate, paralegal, assistant];
}
