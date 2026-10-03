// kernel/grants/roles.js: the five roles as bundles of grants (contract section on roles; contracts roles.d.ts). A membership expands to grants
// whose `source` is `role:<id>`; the abilities in ROLE_BUNDLES say what each bundle is for, and this table says which named actions carry them.
// Only named actions, never wildcards (a wildcard never covers admin, grant or outward actions). Per-project overrides may narrow, never widen.
const MEMBER = ["records.read", "records.create", "records.update", "records.remove", "records.restore", "events.read", "tasks.request", "tasks.read", "tasks.work", "tasks.decide", "grants.offer"];
const MANAGER = [...MEMBER, "records.define", "grants.list"];
const ADMIN = [...MANAGER, "grants.create", "grants.revoke", "grants.narrow", "grants.role"];
export const ROLE_ACTIONS = Object.freeze({
  owner: Object.freeze([...ADMIN]),
  admin: Object.freeze([...ADMIN]),
  manager: Object.freeze([...MANAGER]),
  member: Object.freeze([...MEMBER]),
  temp: Object.freeze(["records.read", "records.create", "records.update", "tasks.read", "tasks.work"]),
});
/** Who may set whom: an owner any role; an admin the roles below admin; nobody else. */
export const MAY_SET = Object.freeze({ owner: ["owner", "admin", "manager", "member", "temp"], admin: ["manager", "member", "temp"] });
