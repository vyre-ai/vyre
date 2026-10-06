// kernel/grants/roles.js: the five roles as bundles of grants (contract section on roles; contracts roles.d.ts). A membership expands to grants
// whose `source` is `role:<id>`; the abilities in ROLE_BUNDLES say what each bundle is for, and this table says which named actions carry them.
// A manager changes no types (records.define is Customize: admin and owner, ROLE_BUNDLES customize.definitions; test/roles-enforced.test.js holds the two together).
// Only named actions, never wildcards (a wildcard never covers admin, grant or outward actions). Per-project overrides may narrow, never widen.
// `seal.put`: writing a value INTO a sealed field is part of being able to write that record (lead ruling 4 Oct). The value goes straight to the sealing process and is never stored or logged in the clear;
// reading it back is a separate act (unseal, with presence). A temp member gets it only where a grant of theirs names it; the sealing process refuses a chain with a model in it, so an assistant fills a sealed
// field only through the placeholder path. What a Flow's steps do: a member may start a Flow and give a task (fn.run and model.call are a Flow run's alone: a run needs only flows.run of its approver, and authorize refuses them to anyone else); reading and calling a connected service are an admin's, since an admin approves the Flow that does it, and `service.call` is outward so the vault holds it for a yes anyway. `seal.reveal` (show a sealed value to the person, after their presence) is the owner's and the admin's by role (lead ruling 5 Oct); every other role holds it only by a grant.
const MEMBER = ["memory.read", "records.read", "records.create", "records.update", "records.remove", "records.restore", "seal.put", "events.read", "tasks.request", "tasks.read", "tasks.work", "tasks.decide", "project.reach", "grants.offer", "grants.unoffer", "flows.run", "ask.request"];
const MANAGER = [...MEMBER, "grants.list", "rules.list", "rules.get", "rules.test", "rules.propose"];
const ADMIN = [...MANAGER, "memory.file", "memory.retire", "seal.reveal", "seal.export", "records.define", "grants.create", "grants.revoke", "grants.narrow", "grants.role", "grants.invite", "project.move_out", "project.move_in", "project.move_finish", "space.upgrade", "space.upgrade_finish", "records.import", "drive.read", "drive.write", "drive.restore", "kits.propose", "kits.install", "kits.remove", "rules.set", "rules.enable", "rules.disable", "rules.remove", "rules.accept", "rules.dismiss", "service.read", "service.call"];
export const ROLE_ACTIONS = Object.freeze({
  // The owner alone holds the two checkpoint actions so that the owner's chain can mint a per-session grant of them (a grant must lie inside its giver's authority); no other role has them.
  owner: Object.freeze([...ADMIN, "checkpoint.write", "checkpoint.read"]),
  admin: Object.freeze([...ADMIN]),
  manager: Object.freeze([...MANAGER]),
  member: Object.freeze([...MEMBER]),
  temp: Object.freeze(["records.read", "records.create", "records.update", "tasks.read", "tasks.work"]),
});
/** Who may set whom: an owner any role; an admin the roles below admin; nobody else. */
export const MAY_SET = Object.freeze({ owner: ["owner", "admin", "manager", "member", "temp"], admin: ["manager", "member", "temp"] });
