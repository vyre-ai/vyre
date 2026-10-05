// @ts-check
// Settings, pure parts: AI budgets, the privacy defaults, notifications, updates. Node tests them.

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
  if (s > 1) return `${a.name} is over its budget. Assistants on it stop and ask you.`;
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
  ["ask", "Ask before an assistant opens a sealed file", "You approve with Face ID each time."],
  ["mem", "Memory learns from what assistants read", "Sealed values are never read, so they are never remembered."],
];

/** Rows only an owner or admin can use (DESIGN-spaces-first.md, roles): Customize, sealing policy and Kits. Rules stay for everyone but temp: anyone can propose one (RulesScreen). */
const ADMIN_ROWS = ["/u/settings/customize", "/u/settings/privacy", "/u/kits"];
/** Rows a temp member has no use for: they see only the projects named, so the space-wide places stay out of Settings. */
const NOT_FOR_TEMP = ["/u/memory", "/u/flows", "/u/settings/seeing", "/u/settings/rules"];

/**
 * Settings home, in the prototype's groups. `space` names the group for the space showing. `role` is the person's role in it: a row their role cannot use
 * is not offered. No role (All spaces showing, or not known yet) shows every row, and the screen behind each row still decides.
 * @param {string} space @param {string} [role]
 */
export function settingsGroups(space, role) {
  const hide = (/** @type {string} */ href) => !!role && ((role !== "owner" && role !== "admin" && ADMIN_ROWS.includes(href)) || (role === "temp" && NOT_FOR_TEMP.includes(href)));
  return all(space).map((g) => ({ ...g, rows: g.rows.filter((r) => !hide(r[2])) })).filter((g) => g.rows.length);
}

function all(/** @type {string} */ space) {
  return [
    { title: "You", rows: [
      ["Account and recovery", "Sign-in, recovery code", "/u/settings/account", "faceid"],
      ["Appearance", "Theme, accent, density, font", "/u/appearance", "settings"],
      ["Notifications", "What can reach you, and when", "/u/settings/notifications", "bell"],
      ["AI accounts", "Claude, OpenAI and others, with budgets", "/u/settings/ai", "key"],
      ["Spending limits", "A daily cap per provider", "/u/settings/spend", "download"],
      ["Standing permissions", "What may go without asking", "/u/settings/permissions", "shield"],
      ["What my assistants can see", "Per space", "/u/settings/seeing", "eye"],
    ] },
    { title: "Devices", rows: [
      ["Devices", "Phone, computers, servers", "/u/settings/devices", "devices"],
      ["Access", "People, assistants, Kits and Flows", "/u/access", "shield"],
    ] },
    { title: space, rows: [
      ["Customize", "Types, fields, stages", "/u/settings/customize", "file"],
      ["Spaces and members", "Who is in them", "/u/spaces", "space"],
      ["Rules", "Never, drafts only, always ask", "/u/settings/rules", "shield"],
      ["Privacy and sealing", "Admins only", "/u/settings/privacy", "vault"],
      ["Kits", "Installed and available", "/u/kits", "box"],
    ] },
    { title: "More places", rows: [
      ["Memory", "What Vyre knows", "/u/memory", "memory"],
      ["Vault", "Logins, keys, cards", "/u/vault", "vault"],
      ["Flows", "What runs by itself", "/u/flows", "flows"],
      ["Planner", "Agenda, alarms, todos, notes", "/u/planner", "cal"],
      ["Assistants", "juno, kit and @Engineer", "/u/settings/assistants", "assistants"],
    ] },
    { title: "Vyre", rows: [
      ["All settings", "Every setting, in one place", "/u/settings/all", "settings"],
      ["This computer", "What runs here, history, shares", "/u/settings/system", "info"],
      ["Updates", "Check for a new version", "/u/settings/updates", "download"],
      ["About", "Version and open-source credits", "/u/about", "info"],
    ] },
  ];
}
