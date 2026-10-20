// @ts-check
// Settings, pure parts: AI budgets, the privacy defaults, notifications, updates, the Settings list. Node tests them.
import { labsRows } from "./archived.js";

export const money = (/** @type {number} */ n) => `$${n.toLocaleString("en-US")}`;

/** Used as a share of the budget: 0 to 1 (more than 1 means over). A budget of 0 is "no limit set": 0. */
export function usedShare(/** @type {number} */ used, /** @type {number} */ budget) {
  return budget > 0 ? used / budget : 0;
}
export const usedPercent = (/** @type {number} */ used, /** @type {number} */ budget) => Math.round(usedShare(used, budget) * 100);

/** The line under a connected account. */
export function budgetLine(/** @type {{ budget: number, used: number }} */ a) {
  return `Budget ${money(a.budget)} a month, used ${money(a.used)} this month`;
}

export const BUDGET_STEPS = [25, 50, 100, 200, 500];

/** What the person is told when a budget runs out. Nothing else is cut off: the assistant asks first. */
export function overLine(/** @type {{ name: string, budget: number, used: number }} */ a) {
  const s = usedShare(a.used, a.budget);
  if (s > 1) return `${a.name} is over its budget. Agents on it stop and ask you.`;
  if (s > 0.9) return `${a.name} is close to its budget.`;
  return "";
}

/** Connect or disconnect one account. A connection needs a plan and a budget; a disconnect keeps nothing but the name. */
export function toggleAccount(/** @type {any} */ a) {
  return a.on ? { ...a, on: false, plan: "", budget: 0, used: 0 } : { ...a, on: true, plan: "API account", budget: 50, used: 0 };
}

export const AUTONOMY = [["asks", "Asks first"], ["exceptions", "On exceptions"], ["alone", "Alone"]];
export const RETENTION = [["3m", "3 months"], ["1y", "1 year"], ["never", "Never"]];

export const NOTIFY_ROWS = [
  ["need", "Something needs you", "Asks, approvals and pairing requests."],
  ["flow", "A Flow is waiting on you", "When a step asks a person."],
  ["reveal", "A sealed value was revealed", "Every Reveal, on every device."],
  ["upd", "Updates available", "Vyre and Kit updates."],
  ["quiet", "Quiet hours", "10 pm to 7 am. Only asks marked urgent come through."],
];

export const PRIVACY_ROWS = [
  ["seal", "Seal new SSN and account fields", "Fields of the sealed kind start sealed. Any field can still be sealed by hand."],
  ["ask", "Ask before an agent opens a sealed file", "You approve with Face ID each time."],
  ["mem", "Memory learns from what agents read", "Sealed values are never read, so they are never remembered."],
];

/** Rows only an owner or admin can use (DESIGN-spaces-first.md, roles): People and roles, sealing policy, and the archived Audit and Groups when Labs shows them. */
const ADMIN_ROWS = ["/u/settings/audit", "/u/settings/roles", "/u/settings/groups", "/u/settings/customize", "/u/settings/privacy", "/u/kits", "/u/settings/engineer", "/u/playbooks"];
/** Rows a temp member has no use for: they see only the projects named, so the space-wide places stay out of Settings. */
const NOT_FOR_TEMP = ["/u/memory", "/u/flows", "/u/settings/seeing", "/u/settings/rules", "/u/settings/assistant-access"];

/**
 * Settings home: three calm groups (your account in the Space, the Space, Everywhere) and nothing behind an Advanced switch. The pages taken off the list are in archived.js with one line of why each; with Labs on
 * (About, at the bottom) the archived ones come back as a last group, Labs. Every row has its own icon from the family (logic.test.js keeps it so). `space` names the group for the space showing.
 * `role` is the person's role there: a row an owner or admin uses is not offered to others, and a temp member is not offered the space-wide places. No role (All spaces showing, or not known yet)
 * shows every row, and the screen behind each row still decides.
 * @param {string} space @param {string} [role] @param {{ labs?: boolean }} [opts]
 */
export function settingsGroups(space, role, opts = {}) {
  const hide = (/** @type {string} */ href) => !!role && ((role !== "owner" && role !== "admin" && ADMIN_ROWS.includes(href)) || (role === "temp" && NOT_FOR_TEMP.includes(href)));
  const groups = [...all(space), ...(opts.labs ? [{ title: "Labs", labs: true, rows: labsRows() }] : [])];
  return groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !hide(r[2])) })).filter((g) => g.rows.length);
}

/** @returns {{ title: string, labs?: boolean, rows: string[][] }[]} */
function all(/** @type {string} */ space) {
  // Only the sign-in (username, password, GitHub) and the devices are the same in every Space; everything else is this Space's (owner, 21 Oct 2026).
  return [
    { title: `Your account in ${space}`, rows: [
      ["Your profile", "The name, look and avatar you show in this Space", "/u/settings/profile", "person"],
      ["AI accounts", "Every AI account your agents use here, from any provider", "/u/settings/ai", "spark"],
      ["Appearance", "Theme, accent colour, density and font", "/u/appearance", "sun"],
      ["Notifications", "Choose what can reach you from this Space, and when", "/u/settings/notifications", "bell"],
      ["Sidebar", "Choose and order the places in your sidebar", "/u/sidebar", "menu"],
    ] },
    { title: space, rows: [
      ["Look and name", "Switch Space, and change a Space's name, colour and logo", "/u/spaces", "space"],
      ["People and roles", "Who is in this Space and what each person can do, see and use", "/u/settings/roles", "users"],
      ["Skills and plugins", "Yours and the Space's; members draft, admins approve for everyone", "/u/skills", "box"],
      ["Connections", "Link services, Google and GitHub", "/u/connections", "link"],
      ["What agents may do", "The areas and tools your agents may use, and what they ask first", "/u/settings/assistant-access", "shield"],
      ["Privacy", "Choose which fields are sealed (admins only)", "/u/settings/privacy", "sealed"],
      ["Updates and backups", "Check for and install a new version, and see what is backed up", "/u/settings/updates", "download"],
      ["Agent computer", "What runs on this computer for this Space: history, hooks and shares", "/u/settings/system", "laptop"],
    ] },
    { title: "Everywhere", rows: [
      ["Sign-in and recovery", "Your username, password and recovery code, and your GitHub link", "/u/settings/account", "face"],
      ["Devices and computers", "Your phone and computers; approve a new one, remove one you lost", "/u/settings/devices", "devices"],
      ["About", "Version, who made Vyre, and where to star it", "/u/about", "info"],
    ] },
  ];
}
