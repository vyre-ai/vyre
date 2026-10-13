// @ts-check
// Roles: the built-ins, the sentence under a role, who may see the screen and invite, removal refused in words, new and duplicate, and every edit.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { BUILT_INS, inviteChoices, TOOLS, builtInRoles, canEditRoles, duplicateRole, holdersLine, invitable, list, newRole, nameProblem, removeRefusal, rolesRefusal, screenRole, sees, setAccess, setCan, setHidden, setProject, setTool, setWhere, starting, withTypes, wireRole } from "./model.js";
import { bodyOf, catalogueOf, mockSource, projectsOf, roleOf, rolesOf, rolesSource, typesOf } from "./source.js";

test("the built-ins are Admin, Member and Guest, Guest is temp on the wire, manager is not among them", () => {
  assert.deepEqual(BUILT_INS.map((b) => b.name), ["Admin", "Member", "Guest"]);
  assert.equal(wireRole("guest"), "temp");
  assert.equal(screenRole("temp"), "guest");
  assert.equal(wireRole("member"), "member");
  assert.ok(!BUILT_INS.some((b) => b.id === "manager"));
});

test("a new member starts with their projects only and no mail, calendar or computers", () => {
  const m = starting("member");
  assert.equal(m.where.kind, "seats");
  for (const [k] of TOOLS) assert.equal(m.tools[k], false, k);
  assert.equal(starting("admin").tools.computers, true);
  assert.equal(starting("guest").can.create, false);
});

test("only an owner or admin sees Roles", () => {
  assert.equal(canEditRoles("owner"), true);
  assert.equal(canEditRoles("admin"), true);
  assert.equal(canEditRoles("member"), false);
  assert.equal(canEditRoles("temp"), false);
  assert.equal(canEditRoles(undefined), false);
});

test("an owner invites with any role but Owner; an admin cannot give Admin or a role that starts from it", () => {
  const roles = [...builtInRoles(), { ...newRole("admin", "Partner", builtInRoles()) }, { ...newRole("member", "Paralegal", builtInRoles()) }];
  assert.deepEqual(invitable("owner", roles).map((r) => r.name), ["Admin", "Member", "Guest", "Partner", "Paralegal"]);
  assert.deepEqual(invitable("admin", roles).map((r) => r.name), ["Member", "Guest", "Paralegal"]);
  assert.deepEqual(invitable("member", roles), []);
});

test("the sentence under a role says where, what data and which tools", () => {
  const base = builtInRoles();
  const para = setTool(setTool(newRole("member", "Paralegal", base), "documents", true), "files", true);
  assert.equal(sees(para), "The projects they are on. Edits Clients, Projects, Invoices and Documents. Documents and files on.");
  const none = newRole("member", "Quiet", base);
  assert.equal(sees(setAccess(setAccess(setAccess(setAccess(none, "client", "none"), "project", "none"), "invoice", "none"), "document", "none")), "The projects they are on. No records. No mail, calendar or computers.");
  const chosen = setProject(setWhere(para, "chosen"), "smith", true);
  assert.ok(sees(chosen, { smith: "Smith estate" }).startsWith("Only Smith estate."));
  assert.equal(sees(setAccess(setAccess(para, "invoice", "read"), "document", "read")), "The projects they are on. Edits Clients and Projects, reads Invoices and Documents. Documents and files on.");
  assert.equal(sees(setAccess(setAccess(setAccess(setAccess(para, "client", "read"), "project", "read"), "invoice", "read"), "document", "read")), "The projects they are on. Reads Clients, Projects, Invoices and Documents. Documents and files on.");
  assert.ok(sees(starting("admin") && { ...newRole("admin", "Partner", builtInRoles()) }).endsWith("All tools on."));
  assert.equal(sees(builtInRoles()[2]), BUILT_INS[1].line);
  assert.equal(list(["a", "b", "c"]), "a, b and c");
  assert.equal(holdersLine(1), "1 person");
  assert.equal(holdersLine(4), "4 people");
});

test("a role cannot be removed while people hold it, nor if it is built in, and says so in words", () => {
  const base = builtInRoles();
  assert.match(removeRefusal(base[1]), /built in/);
  const r = { ...newRole("member", "Associate", base), holders: 3 };
  assert.equal(removeRefusal(r), "3 people hold Associate. Give everyone another role first, then remove it.");
  assert.equal(removeRefusal({ ...r, holders: 1 }), "1 person holds Associate. Give them another role first, then remove it.");
  assert.equal(removeRefusal({ ...r, holders: 0 }), "");
});

test("names: required, unique ignoring case, not too long", () => {
  const roles = builtInRoles();
  assert.equal(nameProblem("", roles), "Give the role a name.");
  assert.match(nameProblem("admin", roles), /already exists/);
  assert.equal(nameProblem("Paralegal", roles), "");
  assert.equal(nameProblem("x".repeat(41), roles), "Keep the name to 40 characters.");
  const r = newRole("member", "Paralegal", roles);
  assert.equal(nameProblem("paralegal", [...roles, r], r.id), "");
});

test("a new role starts from a built-in; a duplicate keeps every setting under a free name; neither can be above Admin", () => {
  const base = builtInRoles();
  const a = newRole("guest", "Contractor", base);
  assert.equal(a.id, "contractor");
  assert.equal(a.from, "guest");
  assert.equal(a.builtin, false);
  assert.deepEqual(a.where, starting("guest").where);
  const own = setHidden(setTool(a, "mail", true), "client", "SSN", true);
  const all = [...base, own];
  const d = duplicateRole(own, all);
  assert.equal(d.name, "Contractor copy");
  assert.equal(d.from, "guest");
  assert.equal(d.tools.mail, true);
  assert.deepEqual(d.data.find((x) => x.id === "client")?.hidden, ["SSN"]);
  assert.equal(duplicateRole(own, [...all, d]).name, "Contractor copy 2");
  assert.equal(duplicateRole(base[0], base).from, "admin", "copying the owner makes an admin-level role, never above it");
  assert.equal(newRole("owner", "Boss", base).from, "admin");
  assert.equal(newRole("member", "Admin", base).id, "admin-2", "an id never equals a built-in's");
});

test("edits return a new role and never change the old one", () => {
  const base = builtInRoles();
  const r = newRole("member", "Paralegal", base);
  const on = setCan(r, "invite", true);
  assert.equal(on.can.invite, true);
  assert.equal(r.can.invite, false);
  assert.deepEqual(setWhere(setProject(setWhere(r, "chosen"), "a", true), "seats").where, { kind: "seats", projects: [] });
  assert.deepEqual(setProject(setProject(r, "a", true), "a", true).where.projects, ["a"]);
  assert.deepEqual(setProject(setProject(r, "a", true), "a", false).where.projects, []);
  const hidden = setHidden(r, "client", "SSN", true);
  assert.equal(setAccess(hidden, "client", "none").data[0].hidden.length, 0, "a type that is not seen hides no fields");
  assert.equal(setAccess(hidden, "client", "read").data[0].hidden.length, 1);
});

test("a type the role does not mention is None, never open by accident", () => {
  const r = { ...newRole("member", "P", builtInRoles()), data: [] };
  const t = [{ id: "case", name: "Cases", fields: [] }];
  assert.deepEqual(withTypes(r, t).data, [{ id: "case", name: "Cases", access: "none", hidden: [] }]);
});

test("roles-core's role is read: label, base, people, id lists, a level per type, hidden fields apart", () => {
  const types = [{ id: "client", name: "Clients", fields: ["SSN"] }, { id: "invoice", name: "Invoices", fields: [] }];
  const r = roleOf({ id: "paralegal", label: "Paralegal", base: "member", people: 4, can: ["view", "edit"], where: { kind: "projects", projects: ["p1"] }, data: { client: "edit", invoice: "weird" }, hidden_fields: { client: ["SSN"] }, tools: ["mail"] }, types);
  assert.deepEqual([r.name, r.from, r.holders, r.builtin], ["Paralegal", "member", 4, false]);
  assert.deepEqual(r.can, { view: true, edit: true });
  assert.deepEqual(r.where, { kind: "chosen", projects: ["p1"] });
  assert.deepEqual(r.data, [{ id: "client", name: "Clients", access: "edit", hidden: ["SSN"] }, { id: "invoice", name: "Invoices", access: "none", hidden: [] }]);
  assert.deepEqual(r.tools, { mail: true });
  const open = roleOf({ id: "x", can: ["view"] }, types);
  assert.deepEqual(open.data.map((d) => d.access), ["read", "read"], "no data: the can switches apply to every type");
  assert.equal(roleOf({ id: "guest" }).builtin, true);
  assert.deepEqual(roleOf({ id: "a", where: { kind: "my_projects" } }).where.kind, "seats");
  assert.deepEqual(rolesOf({ roles: [{ id: "a", label: "A" }, null, { label: "no id" }] }).map((x) => x.id), ["a"]);
  assert.deepEqual(typesOf({ types: [{ id: "client", plural: "Clients", fields: [{ label: "Phone" }, "SSN"] }] }), [{ id: "client", name: "Clients", fields: ["Phone", "SSN"] }]);
  assert.deepEqual(projectsOf([{ id: 1, title: "Smith estate" }, {}]), [{ id: "1", name: "Smith estate" }]);
});

test("a role goes to the box as id lists, a level per type and hidden fields apart", () => {
  const r = setHidden(setTool(setWhere(setCan(newRole("member", "P", builtInRoles()), "invite", true), "chosen"), "mail", true), "client", "SSN", true);
  const b = bodyOf(setProject(r, "p1", true));
  assert.ok(b.can.includes("invite") && b.can.includes("view") && !b.can.includes("delete"));
  assert.deepEqual(b.where, { kind: "projects", projects: ["p1"] });
  assert.equal(b.data.client, "edit");
  assert.deepEqual(b.hidden_fields, { client: ["SSN"] });
  assert.deepEqual(b.tools, ["mail"]);
  assert.equal(bodyOf(newRole("member", "Q", builtInRoles())).where.kind, "my_projects");
  assert.equal(catalogueOf({ can: [{ id: "view", label: "See", gloss: "g" }], tools: [{ id: "mail", label: "Mail" }] })?.tools[0][0], "mail");
  assert.equal(catalogueOf(null), null);
});

test("a refused call is said in words", () => {
  assert.equal(rolesRefusal("not_allowed"), "Only an owner or admin changes roles.");
  assert.equal(rolesRefusal("role_in_use"), "Someone still holds that role. Give them another role first.");
  assert.equal(rolesRefusal("odd", "The box said this."), "The box said this.");
  assert.equal(rolesRefusal(undefined), "That did not go through.");
});

test("the sample world shows a firm's roles: Partner, Associate, Paralegal, Assistant, with people in them", async () => {
  const src = mockSource();
  const w = await src.read();
  const custom = w.roles.filter((r) => !r.builtin);
  assert.deepEqual(custom.map((r) => r.name), ["Partner", "Associate", "Paralegal", "Assistant"]);
  assert.ok(custom.every((r) => r.holders > 0));
  assert.equal(w.roles.filter((r) => r.builtin).length, 4);
  const assistant = custom[3];
  assert.equal(assistant.where.kind, "chosen");
  assert.ok(assistant.where.projects.every((p) => w.projects.some((x) => x.id === p)));
});

test("the sample source creates, saves, duplicates and refuses removal while held", async () => {
  const src = mockSource();
  let told = 0;
  src.subscribe(() => { told++; });
  const made = await src.create("member", "Contractor");
  assert.equal(made.holders, 0);
  await assert.rejects(src.create("member", "contractor"), { code: "name_taken" });
  await src.save(setTool(made, "mail", true));
  const copy = await src.duplicate(made.id);
  assert.equal(copy.name, "Contractor copy");
  assert.equal(copy.tools.mail, true);
  const w = await src.read();
  assert.equal(w.roles.find((r) => r.id === made.id)?.tools.mail, true);
  const assoc = w.roles.find((r) => r.name === "Associate");
  await assert.rejects(src.remove(String(assoc?.id)), { code: "role_in_use" });
  await src.remove(made.id);
  assert.ok(!(await src.read()).roles.some((r) => r.id === made.id));
  assert.ok(told >= 4);
});

test("the real source reads each role with roles.get and sends roles.create with a base", async () => {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "roles.list") return { data: { roles: [{ id: "owner", label: "Owner", people: 1, builtin: true }, { id: "paralegal", label: "Paralegal", people: 2, base: "member" }] } };
    if (tool === "roles.get") return { data: { role: { id: input.id, label: input.id === "owner" ? "Owner" : "Paralegal", base: "member", can: ["view"], tools: ["mail"] } } };
    if (tool === "roles.remove") return { error: { code: "role_in_use", message: "held" } };
    if (tool === "roles.update") return { data: { role: { id: input.id, label: "Para" }, reapplied: 2 } };
    if (tool === "roles.create") return { data: { role: { id: "contractor", label: "Contractor", base: "member" } } };
    return { error: { code: "unknown_tool", message: "no" } };
  };
  const src = rolesSource(call);
  const w = await src.read();
  assert.deepEqual(w.roles.map((r) => [r.id, r.holders]), [["owner", 1], ["paralegal", 2]]);
  assert.equal(w.roles[1].tools.mail, true);
  assert.ok(w.types.length > 0, "types fall back to the sample types when the box does not say");
  await src.create("admin", "Contractor");
  const made = seen.find((s) => s.tool === "roles.create")?.input.role;
  assert.equal(made.label, "Contractor");
  assert.equal(made.base, "member", "a custom role starts from Member only");
  await assert.rejects(src.remove("x"), { code: "role_in_use" });
  await src.save({ ...w.roles[1], name: "Para" });
  assert.deepEqual(seen.find((s) => s.tool === "roles.update")?.input.id, "paralegal");
});
