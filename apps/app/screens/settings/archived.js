// @ts-check
// The Settings pages taken off the Settings list, the one list of them, each with why (owner, 20 Oct: "these pages need to be archived so they aren't visible ... all I find is half built things").
// Nothing here is deleted. `archived` pages are not on the Settings list, the Settings panel or the search, and their routes open only while Labs is on (About, at the bottom); with Labs off the
// route goes back to Settings (ArchivedGate). `merged` pages live on inside another page. `moved` pages are not Settings: they keep their own way in from elsewhere in the app.

/** @typedef {{ title: string, sub: string, href: string, icon: string, kind: "archived" | "merged" | "moved", into?: string, reason: string }} Archived */

/** @type {readonly Archived[]} */
export const ARCHIVED = Object.freeze([
  { title: "Access", sub: "Who and what can reach this Space", href: "/u/access", icon: "access", kind: "archived",
    reason: "The same device list as Devices and computers (the same useDevices store), under another name." },
  { title: "All settings", sub: "Every raw setting this server offers", href: "/u/settings/all", icon: "settings", kind: "archived",
    reason: "Raw server keys for developers; an owner meets each setting on its own page." },
  { title: "Rules", sub: "What an agent never does, drafts only, or asks about first", href: "/u/settings/rules", icon: "hand", kind: "merged", into: "/u/settings/roles",
    reason: "Rules sit on People and roles, with the people they apply to." },
  { title: "Groups", sub: "Sets of people and agents you give things to at once", href: "/u/settings/groups", icon: "contacts", kind: "merged", into: "/u/settings/roles",
    reason: "Groups sit on People and roles, beside the people in them." },
  { title: "Servers", sub: "The servers this device is paired to", href: "/u/settings/servers", icon: "server", kind: "merged", into: "/u/settings/devices",
    reason: "Servers sit on Devices and computers, with the phones and computers signed in." },
  { title: "AI keys for outside tools", sub: "A key for each AI tool that acts as you", href: "/u/settings/mcp", icon: "key", kind: "merged", into: "/u/connections",
    reason: "The keys outside tools use sit on Connections, on the MCP section." },
  { title: "Spending limits", sub: "Cap what each AI provider can spend in a day", href: "/u/settings/spend", icon: "budget", kind: "merged", into: "/u/settings/assistant-access",
    reason: "Spend is a section of What agents may do, not its own page." },
  { title: "Standing permissions", sub: "Decide what may go ahead without asking you", href: "/u/settings/permissions", icon: "shield", kind: "merged", into: "/u/settings/assistant-access",
    reason: "Permissions are a section of What agents may do, not their own page." },
  { title: "Outside agents", sub: "Let agents running elsewhere reach what you choose", href: "/u/settings/outside", icon: "share", kind: "merged", into: "/u/settings/assistant-access",
    reason: "Outside is a section of What agents may do, not its own page." },
  { title: "Backups", sub: "Which Spaces are backed up", href: "/u/settings/backups", icon: "storage", kind: "merged", into: "/u/settings/updates",
    reason: "Updates and backups promised backups but showed only updates; the backups list now sits on that page." },
  { title: "Skills and plugins (personal)", sub: "The skills and plugins only you use", href: "/u/skills?level=personal", icon: "board", kind: "merged", into: "/u/skills",
    reason: "One Skills and plugins row now: the library has its own Personal and Space switch." },
  { title: "Build", sub: "Playbooks, objects, templates and Kits", href: "/u/playbooks", icon: "kits", kind: "moved",
    reason: "Build is its own place in the main sidebar (lib/sidebar/model.js)." },
  { title: "Engineer", sub: "Set up your Space by describing what you want", href: "/u/settings/engineer", icon: "bolt", kind: "moved",
    reason: "Only a redirect to /u/engineer, which New agent and Make an app open." },
]);

/** The path of an href, without its query. @param {string} href */
const pathOf = (href) => String(href || "").split("?")[0];

/** The archived entry an address falls under (kind "archived" only), or null. Merged and moved pages still open as before. @param {string} href */
export function archivedAt(href) {
  const p = pathOf(href);
  return ARCHIVED.find((a) => a.kind === "archived" && pathOf(a.href) === p) ?? null;
}

/** True when this exact href was taken off the Settings list (any kind). @param {string} href */
export const isOffSettings = (href) => ARCHIVED.some((a) => a.href === href);

/** The rows the Labs group shows: the archived pages, as Settings rows [title, sub, href, icon]. */
export const labsRows = () => ARCHIVED.filter((a) => a.kind === "archived").map((a) => [a.title, a.sub, a.href, a.icon]);
