// kernel/grants/roles.js: the five roles as bundles of grants (contract section on roles; contracts roles.d.ts). A membership expands to grants
// whose `source` is `role:<id>`; the abilities in ROLE_BUNDLES say what each bundle is for, and this table says which named actions carry them.
// A manager changes no types (records.define is Customize: admin and owner, ROLE_BUNDLES customize.definitions; test/roles-enforced.test.js holds the two together).
// Only named actions, never wildcards (a wildcard never covers admin, grant or outward actions). Per-project overrides may narrow, never widen.
// `seal.put`: writing a value INTO a sealed field is part of being able to write that record (lead ruling 4 Oct). The value goes straight to the sealing process and is never stored or logged in the clear;
// reading it back is a separate act (unseal, with presence). A temp member gets it only where a grant of theirs names it; the sealing process refuses a chain with a model in it, so an assistant fills a sealed
// field only through the placeholder path.
const MEMBER = ["records.read", "records.create", "records.update", "records.remove", "records.restore", "seal.put", "events.read", "tasks.request", "tasks.read", "tasks.work", "tasks.decide", "grants.offer"];
const MANAGER = [...MEMBER, "grants.list", "rules.list", "rules.get", "rules.test", "rules.propose"];
const ADMIN = [...MANAGER, "records.define", "grants.create", "grants.revoke", "grants.narrow", "grants.role", "grants.invite", "drive.read", "drive.write", "drive.restore", "kits.propose", "kits.install", "kits.remove", "rules.set", "rules.enable", "rules.disable", "rules.remove", "rules.accept", "rules.dismiss"];
export const ROLE_ACTIONS = Object.freeze({
  owner: Object.freeze([...ADMIN]),
  admin: Object.freeze([...ADMIN]),
  manager: Object.freeze([...MANAGER]),
  member: Object.freeze([...MEMBER]),
  temp: Object.freeze(["records.read", "records.create", "records.update", "tasks.read", "tasks.work"]),
});
/** Who may set whom: an owner any role; an admin the roles below admin; nobody else. */
export const MAY_SET = Object.freeze({ owner: ["owner", "admin", "manager", "member", "temp"], admin: ["manager", "member", "temp"] });
