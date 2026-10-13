// @ts-check
// roles: the fixed, safe catalogue a custom role is built from. Everything a role can say is a name from here; nothing is typed free-form into a grant.
// Each `can` entry is a plain-words switch over named kernel actions (never a wildcard, never an owner-only action); a role's base decides which of them it may hold
// (kernel/grants/roles.js ROLE_ACTIONS is the one table: an entry is Member's when every action in it is in the Member bundle, Admin's when it is in the Admin bundle only).
import { ROLE_ACTIONS } from "../../kernel/grants/roles.js";
import { ROLE_IDS } from "../../kernel/contracts/index.js";

/** @type {readonly { id: string, label: string, gloss: string, actions: readonly string[] }[]} */
const CAN_RAW = Object.freeze([
  { id: "view", label: "See things", gloss: "Read records, tasks, memory and the activity feed.", actions: ["records.read", "memory.read", "events.read", "tasks.read", "project.reach"] },
  { id: "create", label: "Make new records", gloss: "Add records of the types the role may reach.", actions: ["records.create"] },
  { id: "edit", label: "Change records and do tasks", gloss: "Edit records, fill in sealed fields, work on tasks.", actions: ["records.update", "seal.put", "tasks.work"] },
  { id: "delete", label: "Delete and restore records", gloss: "Move records to the Bin and bring them back.", actions: ["records.remove", "records.restore"] },
  { id: "tasks", label: "Give and decide tasks", gloss: "Ask people or assistants for work, and say yes or no to what comes back.", actions: ["tasks.request", "tasks.decide", "ask.request"] },
  { id: "flows", label: "Start Flows", gloss: "Run a Flow by hand.", actions: ["flows.run"] },
  { id: "computers", label: "Share their own computer", gloss: "Offer their computer for the Space's work, and take the offer back.", actions: ["grants.offer", "grants.unoffer"] },
  { id: "files", label: "Use the shared drive", gloss: "Read, add and restore files in the Space's drive.", actions: ["drive.read", "drive.write", "drive.restore"] },
  { id: "memory", label: "File and retire memory", gloss: "Put facts into the Space's memory and take stale ones out.", actions: ["memory.file", "memory.retire"] },
  { id: "people", label: "See who has access", gloss: "List the people and the access they hold.", actions: ["grants.list"] },
  { id: "rules", label: "See and suggest standing rules", gloss: "Read the Space's rules and suggest one. An owner decides.", actions: ["rules.list", "rules.get", "rules.test", "rules.propose"] },
  { id: "invite", label: "Invite people and set their role", gloss: "Add people and give them a role at or below Member.", actions: ["grants.invite", "grants.member"] },
  { id: "customize", label: "Change record types", gloss: "Add and change the types and fields the Space keeps.", actions: ["records.define"] },
  { id: "kits", label: "Install Kits", gloss: "Ask for, install and remove Kits.", actions: ["kits.propose", "kits.install", "kits.remove"] },
  { id: "services", label: "Use connected accounts", gloss: "Read from and call the accounts the Space has connected. Outward calls still wait for a yes.", actions: ["service.read", "service.call"] },
  { id: "reveal", label: "Reveal and export sealed values", gloss: "Show a sealed value to the person after their presence check, or export it.", actions: ["seal.reveal", "seal.export"] },
]);

const MEMBER_SET = new Set(ROLE_ACTIONS.member);

/** What the switches are, for the app to draw. `needs` is the smallest base that may hold the switch. */
export const CAN = Object.freeze(CAN_RAW.map(c => Object.freeze({ ...c, actions: Object.freeze([...c.actions]), needs: c.actions.every(a => MEMBER_SET.has(a)) ? "member" : "admin" })));
export const CAN_BY_ID = Object.freeze(Object.fromEntries(CAN.map(c => [c.id, c])));

/** Where a role reaches. `my_projects` is the projects the person is on (their seat decides it, as for a Member); `projects` is a chosen list; `mine` is only what they made. */
export const WHERE_KINDS = Object.freeze(["space", "my_projects", "projects", "mine"]);
export const ACCESS_LEVELS = Object.freeze(["none", "read", "edit"]);
/** The bases a custom role may start from. A custom role starts from Member, so it is a real narrowing (an Admin-based role would still count as an Admin for who may add people); a Guest's reach is set per person when they are added (scope and end date), so it is not a base. */
export const CUSTOM_BASES = Object.freeze(["member"]);
/** Never an id for a custom role: the built-in ones and the Guest alias. */
export const RESERVED_IDS = Object.freeze([...ROLE_IDS, "guest"]);

/** The tools a role may switch on at the door (core/modules/door-lists.js reads this per role). A Member starts with none of them. */
export const TOOLS = Object.freeze([
  { id: "mail", label: "Mail" },
  { id: "calendar", label: "Calendar" },
  { id: "documents", label: "Documents" },
  { id: "files", label: "Files" },
  { id: "publish", label: "Publish" },
  { id: "computers", label: "Computers" },
  { id: "browser", label: "Browser" },
]);
export const TOOL_IDS = Object.freeze(TOOLS.map(t => t.id));

/** Built-in roles as a person sees them. `manager` is not offered (an existing manager keeps working). The kernel's id for Guest is `temp`. */
export const BUILTIN_VIEW = Object.freeze([
  { id: "owner", kernel: "owner", label: "Owner", description: "Everything, including the server, the Space's vault and handing ownership over." },
  { id: "admin", kernel: "admin", label: "Admin", description: "Runs the Space: people, roles, Kits, rules and connected accounts. Cannot remove the owner." },
  { id: "member", kernel: "member", label: "Member", description: "Does the work in the projects they are on: tasks, chats and their own AI. No mail, calendar or computers until a role turns them on." },
  { id: "guest", kernel: "temp", label: "Guest", description: "A contractor or helper: only what is shared with them, with an end date." },
]);
/** What a person may type for a role, mapped to the kernel's id. */
export const ALIASES = Object.freeze({ guest: "temp" });
/** The tools each built-in role has at the door: the owner and admins have them all, a member and a guest start with none. */
export const BUILTIN_TOOLS = Object.freeze({ owner: TOOL_IDS, admin: TOOL_IDS, manager: Object.freeze([]), member: Object.freeze([]), temp: Object.freeze([]) });
