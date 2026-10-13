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

/** Rows only an owner or admin can use (DESIGN-spaces-first.md, roles): Customize, sealing policy and Kits. Rules stay for everyone but temp: anyone can propose one (RulesScreen). */
const ADMIN_ROWS = ["/u/settings/roles", "/u/settings/customize", "/u/settings/privacy", "/u/kits", "/u/settings/engineer"];
/** Rows a temp member has no use for: they see only the projects named, so the space-wide places stay out of Settings. */
const NOT_FOR_TEMP = ["/u/memory", "/u/flows", "/u/settings/seeing", "/u/settings/rules"];

/**
 * Settings home, in the prototype's groups. Every place has its own icon from the family (logic.test.js keeps it so): a list of ten rows reads at a glance only when no two look alike. `space` names the group for the space showing. `role` is the person's role in it: a row their role cannot use
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
      ["Account and recovery", "Your sign-in, recovery code and GitHub link", "/u/settings/account", "face"],
      ["Appearance", "Theme, accent colour, density and font", "/u/appearance", "sun"],
      ["Sidebar", "Choose and order the places in your sidebar", "/u/sidebar", "menu"],
      ["Notifications", "Choose what can reach you, and when", "/u/settings/notifications", "bell"],
      ["AI accounts", "Connect Claude, OpenAI and others, each with a budget", "/u/settings/ai", "spark"],
      ["Connections", "Link services, MCP servers, Google and GitHub", "/u/connections", "link"],
      ["Your AI keys", "Name a key for each AI tool that acts as you", "/u/settings/mcp", "key"],
      ["Outside agents", "Let agents running elsewhere reach what you choose", "/u/settings/outside", "agents"],
      ["Spending limits", "Cap what each AI provider can spend in a day", "/u/settings/spend", "budget"],
      ["Standing permissions", "Decide what may go ahead without asking you", "/u/settings/permissions", "shield"],
      ["What my agents can see", "Choose, Space by Space, what your agents may read", "/u/settings/seeing", "eye"],
      ["What my agent may do", "Turn off tools and areas your assistant may use", "/u/settings/assistant-access", "filter"],
    ] },
    { title: "Devices", rows: [
      ["Devices", "Your phone and computers; remove one you lost", "/u/settings/devices", "devices"],
      ["Servers", "The servers you use and the Space on each", "/u/settings/servers", "server"],
      ["Backups", "Choose which Spaces are backed up", "/u/settings/backups", "storage"],
      ["Access", "See who and what can reach this Space: people, agents, Kits and Flows", "/u/access", "access"],
    ] },
    { title: space, rows: [
      ["Customize", "Add and change object types, fields and stages", "/u/settings/customize", "records"],
      ["Spaces and members", "Switch Space, see who is in each, invite people", "/u/spaces", "space"],
      ["Roles", "Decide what each person can do, see and use", "/u/settings/roles", "users"],
      ["Rules", "Set what an agent never does, drafts only, or asks about first", "/u/settings/rules", "hand"],
      ["Privacy and sealing", "Choose which fields are sealed (admins only)", "/u/settings/privacy", "sealed"],
      ["Kits", "Add or remove ready-made sets for a kind of work", "/u/kits", "kits"],
      ["Engineer", "Set up your Space by describing what you want", "/u/settings/engineer", "bolt"],
    ] },
    { title: "More places", rows: [
      ["Memory", "See and edit what Vyre remembers", "/u/memory", "memory"],
      ["Vault", "Store logins, keys and cards, sealed", "/u/vault", "vault"],
      ["Flows", "Set up work that runs by itself", "/u/flows", "flows"],
      ["Sites and publishing", "Put pages online from this Space and set their address", "/u/sites", "globe"],
      ["Planner", "Your agenda, alarms, to-dos and notes", "/u/planner", "cal"],
      ["Agents", "Your assistant and the agents that work for you", "/u/settings/assistants", "assistants"],
    ] },
    { title: "Vyre", rows: [
      ["All settings", "Every setting this server offers, with search", "/u/settings/all", "settings"],
      ["This computer", "What runs on this computer, its history and shares", "/u/settings/system", "laptop"],
      ["Updates", "Check for and install a new version", "/u/settings/updates", "download"],
      ["About", "Version, who made Vyre, and where to star it", "/u/about", "info"],
    ] },
  ];
}
