// @ts-check
// Roles in a space (team/0.3.4/ROLES-proposal.html sections 1, 2 and 5): the built-ins an owner can hand out, the custom roles a space makes from them,
// and the four sections a role says (can do, where, which data, which tools). Pure, so Node tests it. Every word the screens print is here.

/** @typedef {"admin"|"member"|"guest"} BuiltIn */
/** @typedef {"space"|"seats"|"chosen"|"own"} WhereKind */
/** @typedef {"none"|"read"|"edit"} Access */
/** @typedef {{ id: string, name: string, access: Access, hidden: string[] }} DataRule */
/**
 * @typedef {{
 *   id: string, name: string, builtin: boolean, from: string, holders: number,
 *   can: Record<string, boolean>, where: { kind: WhereKind, projects: string[] },
 *   data: DataRule[], tools: Record<string, boolean>,
 * }} Role
 */

/** The built-in roles, in the order the screens list them. Owner is listed on the Roles screen but is never handed out from an invite. */
export const OWNER = { id: "owner", name: "Owner", line: "Everything, including billing, the server and handing the space over." };
export const BUILT_INS = [
  { id: "admin", name: "Admin", line: "Runs the space: people, roles, Kits, rules and connected accounts. Cannot remove the owner." },
  { id: "member", name: "Member", line: "Does the work on the projects they are on, with their own tasks and chats. Sees nothing else." },
  { id: "guest", name: "Guest", line: "Sees only the projects shared with them, until an end date." },
];

/** The kernel keeps the Guest role under its old name. A screen says Guest; the box is sent this. @param {string} id */
export const wireRole = (id) => (id === "guest" ? "temp" : id);
/** @param {string} id */
export const screenRole = (id) => (id === "temp" ? "guest" : id);

/** Section 1, Can do: the switches, in plain words. */
export const CAN_DO = [
  ["view", "See work", "Open and read what the role reaches."],
  ["create", "Create new things", "Start projects, tasks and records."],
  ["edit", "Change work", "Edit tasks, records and documents."],
  ["delete", "Delete", "Remove tasks, records and files."],
  ["tasks", "Run tasks", "Start and finish tasks."],
  ["flows", "Run flows", "Start what runs by itself."],
  ["files", "Work with files", "Add and change files."],
  ["memory", "Use memory", "Read and add to what Vyre remembers."],
  ["people", "See people", "See who is in the space."],
  ["rules", "Set rules", "Change what may go without asking."],
  ["invite", "Invite people", "Bring someone into the space."],
  ["customize", "Customize", "Change types, fields and stages."],
  ["kits", "Install Kits", "Add or remove Kits."],
  ["services", "Connect services", "Connect accounts and services."],
  ["reveal", "Reveal sealed values", "Open sealed fields."],
  ["computers", "Use computers", "Run sessions on a computer."],
];

/** Switches a custom role (a Member at heart) cannot hold: the box refuses them, so the screen shows them unavailable. The box's catalogue says which (`needs`); this is the list until it answers. */
export const ADMIN_ONLY = ["customize", "kits", "services", "reveal"];
/** The line under an unavailable switch. */
export const ADMIN_ONLY_LINE = "Only admins can do this.";

/** Section 2, Where. */
export const WHERE = [
  ["space", "The whole space", "Every project in the space."],
  ["seats", "Projects they are on", "Only where they hold a seat."],
  ["chosen", "Chosen projects", "Exactly the projects you tick."],
  ["own", "Only what they made", "Things they created themselves."],
];

/** Section 3, per record type. */
export const ACCESS = [["none", "None"], ["read", "Read"], ["edit", "Edit"]];

/** Why a tool switch is not live: no tool group opens at the door yet (gate-per-role). The editor shows every tool unavailable with its line and never says a tool is on because a switch is set. */
export const TOOL_NOTES = /** @type {Record<string, string>} */ ({
  mail: "Comes when each person connects their own account.", calendar: "Comes when each person connects their own account.", computers: "Comes when each person connects their own account.", browser: "Comes when each person connects their own account.",
  documents: "Comes in a later release.", files: "Comes in a later release.", publish: "Comes in a later release.",
});
/** What each tool will do once it opens, repeated on the assign and invite confirmation (rc1-d's wording). */
export const TOOL_WILL = { documents: "Documents: sends and signs as the Space", publish: "Publish: posts as the Space", files: "Files: the Space's drive and links" };

/** Section 4, Which tools: each on or off for the role. */
export const TOOLS = [
  ["mail", "Mail", "Read and send mail."],
  ["calendar", "Calendar", "See and make events."],
  ["documents", "Documents", "Open and write documents."],
  ["files", "Files", "Browse and add files."],
  ["publish", "Publish", "Put things on the web or send them outside."],
  ["computers", "Computers", "Run sessions on a computer."],
  ["browser", "Browser", "Use a browser on their behalf."],
];

const allOf = (/** @type {string[][]} */ list, /** @type {boolean} */ on) => Object.fromEntries(list.map(([k]) => [k, on]));

/** The record types a role's data section lists until the box says otherwise (a space's own types come from its Kits). @type {{ id: string, name: string, fields: string[] }[]} */
export const SAMPLE_TYPES = [
  { id: "client", name: "Clients", fields: ["Phone", "Email", "SSN", "Private notes"] },
  { id: "project", name: "Projects", fields: ["Fee", "Budget", "Private notes"] },
  { id: "invoice", name: "Invoices", fields: ["Amount", "Rate"] },
  { id: "document", name: "Documents", fields: ["Privileged"] },
];

/** What each built-in starts as. Admin does everything and sees everything; Member works in projects it is on, with no mail, calendar or computers until a role turns them on; Guest reads and works in what is shared. @param {string} id @param {{ id: string, name: string, fields: string[] }[]} [types] */
export function starting(id, types = SAMPLE_TYPES) {
  const rule = (/** @type {Access} */ access) => types.map((t) => ({ id: t.id, name: t.name, access, hidden: /** @type {string[]} */ ([]) }));
  if (id === "admin") return { can: allOf(CAN_DO, true), where: { kind: /** @type {WhereKind} */ ("space"), projects: [] }, data: rule("edit"), tools: allOf(TOOLS, true) };
  if (id === "guest") return { can: { ...allOf(CAN_DO, false), view: true, edit: true }, where: { kind: /** @type {WhereKind} */ ("chosen"), projects: [] }, data: rule("read"), tools: allOf(TOOLS, false) };
  return { can: { ...allOf(CAN_DO, false), view: true, edit: true, create: true, tasks: true, flows: true, files: true, memory: true }, where: { kind: /** @type {WhereKind} */ ("seats"), projects: [] }, data: rule("edit"), tools: allOf(TOOLS, false) };
}

/** @param {string} id */
export const builtInName = (id) => (id === "owner" ? OWNER.name : BUILT_INS.find((b) => b.id === id)?.name ?? id);

/** The built-in roles as Role records, for the list and the read-only view. @param {Record<string, number>} [holders] @param {{ id: string, name: string, fields: string[] }[]} [types] @returns {Role[]} */
export function builtInRoles(holders = {}, types = SAMPLE_TYPES) {
  const owner = { ...starting("admin", types), id: OWNER.id, name: OWNER.name, builtin: true, from: "", holders: holders.owner ?? 1 };
  return [owner, ...BUILT_INS.map((b) => ({ ...starting(b.id, types), id: b.id, name: b.name, builtin: true, from: "", holders: holders[b.id] ?? 0 }))];
}

/** Section 5's one sentence: what a role can see, from its own settings. A built-in has its fixed line. @param {Role} r @param {Record<string, string>} [projectNames] */
export function sees(r, projectNames = {}) {
  if (r.id === OWNER.id) return OWNER.line;
  const fixed = r.builtin ? BUILT_INS.find((b) => b.id === r.id)?.line : "";
  if (fixed) return fixed;
  const where = r.where.kind === "space" ? "Every project in the space"
    : r.where.kind === "seats" ? "The projects they are on"
    : r.where.kind === "own" ? "Only what they made"
    : r.where.projects.length ? `Only ${list(r.where.projects.map((p) => projectNames[p] ?? p))}` : "Only the projects you choose";
  const edits = r.data.filter((d) => d.access === "edit").map((d) => d.name);
  const reads = r.data.filter((d) => d.access === "read").map((d) => d.name);
  const data = !r.data.length ? "" : !edits.length && !reads.length ? " No records." : ` ${cap([edits.length ? `edits ${list(edits)}` : "", reads.length ? `reads ${list(reads)}` : ""].filter(Boolean).join(", "))}.`;
  return `${where}.${data}`;
}

/** "a", "a and b", "a, b and c". @param {string[]} xs */
export function list(xs) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const cap = (/** @type {string} */ s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** @param {number} n */
export const holdersLine = (n) => (n === 1 ? "1 person" : `${n} people`);

/** Who sees the Roles screen: the owner and admins. A member never does, and settings does not list the row for them. @param {string | undefined} actor */
export const canEditRoles = (actor) => actor === "owner" || actor === "admin";

/** The roles an invite offers: an owner may hand out Admin, Member, Guest and every custom role; an admin the same except Admin and custom roles that start from Admin. Never Owner. @param {string | undefined} actor @param {Role[]} roles */
export function invitable(actor, roles) {
  if (!canEditRoles(actor)) return [];
  return roles.filter((r) => r.id !== OWNER.id && (actor === "owner" || (r.id !== "admin" && r.from !== "admin")));
}

/** The words refusing to remove a role, or "" when it may go. Built-ins stay; a role someone holds stays until they are moved. @param {Role} r */
export function removeRefusal(r) {
  if (r.id === OWNER.id || r.builtin) return `${r.name} is built in and stays.`;
  if (r.holders > 0) return `${holdersLine(r.holders)} ${r.holders === 1 ? "holds" : "hold"} ${r.name}. Give ${r.holders === 1 ? "them" : "everyone"} another role first, then remove it.`;
  return "";
}

/** What the invite picker lists: each role the actor may give, by the id the box is sent (Guest is temp), with the sentence of what it can see. @param {string | undefined} actor @param {Role[]} roles @param {Record<string, string>} [projectNames] */
export function inviteChoices(actor, roles, projectNames = {}) {
  return invitable(actor, roles).map((r) => ({ id: wireRole(r.id), name: r.name, line: sees(r, projectNames) }));
}

/** @param {string} name @param {Role[]} roles @param {string} [except] The role's own id when renaming. */
export function nameProblem(name, roles, except = "") {
  const n = name.trim();
  if (!n) return "Give the role a name.";
  if (n.length > 40) return "Keep the name to 40 characters.";
  if (roles.some((r) => r.id !== except && r.name.trim().toLowerCase() === n.toLowerCase())) return `${n} already exists. Pick another name.`;
  return "";
}

/** A new role, starting from a built-in. The copy is never above Admin: it is Admin's settings at most. @param {string} from @param {string} name @param {Role[]} roles @param {{ id: string, name: string, fields: string[] }[]} [types] @returns {Role} */
export function newRole(from, name, roles, types = SAMPLE_TYPES) {
  const base = roles.find((r) => r.id === from);
  const start = base && base.builtin ? { can: base.can, where: base.where, data: base.data, tools: base.tools } : starting(from, types);
  return { id: slug(name, roles), name: name.trim(), builtin: false, from: from === OWNER.id ? "admin" : from, holders: 0, can: { ...start.can }, where: { kind: start.where.kind, projects: [...start.where.projects] }, data: start.data.map((d) => ({ ...d, hidden: [...d.hidden] })), tools: { ...start.tools } };
}

/** A copy of a role with a free name: "Associate copy", then "Associate copy 2". The copy is always a Member-based role (the box refuses an Admin base), so Owner and Admin cannot be duplicated. @param {Role} r @param {Role[]} roles @returns {Role} */
export function duplicateRole(r, roles) {
  let name = `${r.name} copy`;
  for (let i = 2; roles.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${r.name} copy ${i}`;
  return { ...newRole("member", name, roles), can: { ...r.can }, where: { kind: r.where.kind, projects: [...r.where.projects] }, data: r.data.map((d) => ({ ...d, hidden: [...d.hidden] })), tools: { ...r.tools }, from: "member" };
}

/** Whether a role can be duplicated: not Owner or Admin, and not a role that somehow has an Admin base. @param {Role} r */
export const canDuplicate = (r) => r.id !== OWNER.id && r.id !== "admin" && r.from !== "admin";

/** @param {string} name @param {Role[]} roles */
function slug(name, roles) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role";
  let id = base;
  for (let i = 2; roles.some((r) => r.id === id) || BUILT_INS.some((b) => b.id === id) || id === OWNER.id; i++) id = `${base}-${i}`;
  return id;
}

// The edits: each returns a new role, so the screen can show it at once and send the same change to the box.

/** @param {Role} r @param {string} key @param {boolean} on @returns {Role} */
export const setCan = (r, key, on) => ({ ...r, can: { ...r.can, [key]: on } });
/** @param {Role} r @param {string} key @param {boolean} on @returns {Role} */
export const setTool = (r, key, on) => ({ ...r, tools: { ...r.tools, [key]: on } });
/** @param {Role} r @param {WhereKind} kind @returns {Role} */
export const setWhere = (r, kind) => ({ ...r, where: { kind, projects: kind === "chosen" ? r.where.projects : [] } });
/** @param {Role} r @param {string} project @param {boolean} on @returns {Role} */
export const setProject = (r, project, on) => ({ ...r, where: { kind: "chosen", projects: on ? [...new Set([...r.where.projects, project])] : r.where.projects.filter((p) => p !== project) } });
/** Setting a type to None also unhides its fields: a hidden field of a type that is not seen means nothing. @param {Role} r @param {string} type @param {Access} access @returns {Role} */
export const setAccess = (r, type, access) => ({ ...r, data: r.data.map((d) => (d.id === type ? { ...d, access, hidden: access === "none" ? [] : d.hidden } : d)) });
/** @param {Role} r @param {string} type @param {string} field @param {boolean} hide @returns {Role} */
export const setHidden = (r, type, field, hide) => ({ ...r, data: r.data.map((d) => (d.id === type ? { ...d, hidden: hide ? [...new Set([...d.hidden, field])] : d.hidden.filter((f) => f !== field) } : d)) });

/** A role's data rules, completed with the space's record types: a type the role does not mention is None, so a new type is never open by accident. @param {Role} r @param {{ id: string, name: string, fields: string[] }[]} types */
export function withTypes(r, types) {
  return { ...r, data: types.map((t) => r.data.find((d) => d.id === t.id) ?? { id: t.id, name: t.name, access: /** @type {Access} */ ("none"), hidden: /** @type {string[]} */ ([]) }) };
}

/** The words for a refused roles call. @param {string | undefined} code @param {string} [message] */
export function rolesRefusal(code, message = "") {
  if (code === "not_allowed" || code === "denied") return "Only an owner or admin changes roles.";
  if (code === "not_found" || code === "unknown_tool") return "Roles are not available on your server yet.";
  if (code === "role_in_use") return "Someone still holds that role. Give them another role first.";
  if (code === "name_taken") return "A role with that name already exists.";
  if (code === "above_admin") return "A role cannot do more than Admin.";
  return message || "That did not go through.";
}
