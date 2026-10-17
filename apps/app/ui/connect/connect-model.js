// @ts-check
// The Connect apps screen's rules, as plain data: which apps show, under which chip, what each row's button says, and who an app may be shared with at which Vault level. It draws nothing and calls nothing;
// ConnectApps.tsx draws it and the screen owns what a tap does. Sample data lives at the end, for the preview and the gallery (the sample world: alex, juno, kit, Juniper Studio).

/** The category chips, in the order the screen shows them. "More" holds whatever fits no other chip. */
export const CATEGORIES = /** @type {const} */ ([["all", "All"], ["productivity", "Productivity"], ["communication", "Communication"], ["design", "Design"], ["code", "Code"], ["data", "Data"], ["more", "More"]]);

/** Catalog group or category words to a chip. */
const CHIP_OF = /** @type {Record<string, string>} */ ({
  work: "productivity", google: "productivity", productivity: "productivity", docs: "productivity", calendar: "productivity", files: "productivity", ops: "productivity",
  mail: "communication", chat: "communication", communication: "communication", meetings: "communication", support: "communication",
  design: "design", dev: "code", code: "code",
  data: "data", finance: "data", crm: "data", search: "data", marketing: "data", analytics: "data",
});

/** @param {{ category?: string }} app @returns {string} one of the chip ids except "all" */
export const chipOf = (app) => CHIP_OF[String(app.category || "").toLowerCase()] || "more";

/**
 * How a row's button reads. `connected` shows "Connected"; `one-tap` shows "Add" and signs in with no setup; `setup` shows "Set up" and says what the person brings first: a token they paste or your team's
 * own developer app. @param {{ state: string }} app
 */
export const buttonOf = (app) => (app.state === "connected" ? "Connected" : app.state === "one-tap" ? "Add" : "Set up");

/** The line under the name when an app needs setup, in the words a person reads. @param {{ state: string, setup?: string }} app */
export function setupLine(app) {
  if (app.state !== "setup") return "";
  return app.setup === "app" ? "Needs setup: your team's own developer app" : "Needs setup: a token you paste";
}

/** @param {string} s */
const norm = (/** @type {string | undefined} */ s) => String(s || "").toLowerCase();

/**
 * What the screen shows for a query and a chip. `count` is how many apps are connected (always across all of them, for the "N connected" at the top). `recommended` is up to three apps to start with, only
 * on the plain All view with no query; `list` is everything that matches, connected ones first, then one-tap, then setup, each by name.
 * @param {any[]} apps @param {{ query?: string, category?: string }} [o]
 */
export function viewOf(apps, o = {}) {
  const terms = norm(o.query).split(/\s+/).filter(Boolean);
  const chip = o.category && o.category !== "all" ? o.category : "";
  const hit = (/** @type {any} */ a) => (!chip || chipOf(a) === chip) && terms.every((t) => norm(`${a.name} ${a.vendor || ""} ${a.blurb || ""}`).includes(t));
  const rank = (/** @type {any} */ a) => (a.state === "connected" ? 0 : a.state === "one-tap" ? 1 : 2);
  const list = apps.filter(hit).sort((a, b) => rank(a) - rank(b) || (norm(a.name) < norm(b.name) ? -1 : 1));
  const plain = !terms.length && !chip;
  const recommended = plain ? apps.filter((a) => a.recommended && a.state !== "connected").slice(0, 3) : [];
  const shown = new Set(recommended.map((a) => a.id));
  return { count: apps.filter((a) => a.state === "connected").length, recommended, list: list.filter((a) => !shown.has(a.id)), empty: !list.length };
}

/** "3 connected", "1 connected", or "Nothing connected yet". @param {number} n */
export const countLine = (n) => (n === 0 ? "Nothing connected yet" : `${n} connected`);

/** The Vault levels an app can be shared at. */
export const LEVELS = /** @type {const} */ ([["fill", "Fill in"], ["read", "Read"], ["edit", "Edit and rotate"]]);

/** What each level lets the other side do, one plain line each. @type {Record<string, string>} */
export const LEVEL_HELP = {
  fill: "Uses the app as you, to the destinations you have set. An agent acting for them is still held at the Gate for your yes.",
  read: "Can also see what the connection holds, without changing it.",
  edit: "Can also change the connection and sign in again.",
};

/** The levels a kind of grantee may get: a person any of them, an agent only Fill in. @param {"person" | "agent"} kind @returns {[string, string][]} */
export const levelsFor = (kind) => (kind === "agent" ? [["fill", "Fill in"]] : LEVELS.map(([v, l]) => /** @type {[string, string]} */ ([v, l])));

/**
 * Share an app with someone at a level, as a new list: the same person twice changes their level, and an agent is held at Fill in whatever was asked.
 * @param {{ who: string, kind: "person" | "agent", level: string }[]} shares @param {{ who: string, kind: "person" | "agent", level: string }} next
 */
export function withShare(shares, next) {
  const level = next.kind === "agent" ? "fill" : LEVELS.some(([v]) => v === next.level) ? next.level : "fill";
  return [...shares.filter((s) => !(s.who === next.who && s.kind === next.kind)), { who: next.who, kind: next.kind, level }];
}

/** @param {{ who: string, kind: "person" | "agent", level: string }[]} shares @param {string} who @param {"person" | "agent"} kind */
export const withoutShare = (shares, who, kind) => shares.filter((s) => !(s.who === who && s.kind === kind));

/** "Shared with alex (Read), juno (Fill in)", or "Only you". @param {{ who: string, level: string }[]} shares */
export function shareLine(shares) {
  if (!shares.length) return "Only you";
  const word = (/** @type {string} */ l) => (LEVELS.find(([v]) => v === l) || ["", l])[1];
  return `Shared with ${shares.map((s) => `${s.who} (${word(s.level)})`).join(", ")}`;
}

/** The short line on a connected row: who it is shared with, as counts ("Shared with 1 person and 2 agents"); the names and levels are in Share with.... @param {{ kind: string }[]} shares */
export function sharedLine(shares) {
  if (!shares.length) return "Only you";
  const n = (/** @type {string} */ k) => shares.filter((s) => s.kind === k).length;
  const part = (/** @type {number} */ c, /** @type {string} */ one, /** @type {string} */ many) => (c === 0 ? "" : c === 1 ? `1 ${one}` : `${c} ${many}`);
  return `Shared with ${[part(n("person"), "person", "people"), part(n("agent"), "agent", "agents")].filter(Boolean).join(" and ")}`;
}

/** The sample world for the preview and the gallery: apps in each state, one already shared. @returns {any[]} */
export function sampleApps() {
  const a = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ blurb, /** @type {string} */ category, /** @type {string} */ state, /** @type {any} */ more = {}) => ({ id, name, vendor: name, blurb, category, state, shares: [], ...more });
  return [
    a("notion", "Notion", "Pages, databases and docs", "productivity", "connected", { shares: [{ who: "alex", kind: "person", level: "edit" }, { who: "juno", kind: "agent", level: "fill" }] }),
    a("linear", "Linear", "Issues and projects", "code", "one-tap", { recommended: true }),
    a("sentry", "Sentry", "Errors and releases", "code", "one-tap"),
    a("stripe", "Stripe", "Payments, invoices and customers", "data", "one-tap", { recommended: true }),
    a("gohighlevel", "GoHighLevel", "Contacts, pipelines and messages", "data", "setup", { setup: "token", recommended: true }),
    a("egnyte", "Egnyte", "Files and folders for the team", "productivity", "one-tap"),
    a("docusign", "DocuSign", "Send and track documents for signature", "productivity", "setup", { setup: "app" }),
    a("slack", "Slack", "Channels and messages", "communication", "setup", { setup: "app" }),
    a("intercom", "Intercom", "Conversations with customers", "communication", "one-tap"),
    a("canva", "Canva", "Designs and brand kits", "design", "one-tap"),
    a("miro", "Miro", "Boards and diagrams", "design", "one-tap"),
    a("airtable", "Airtable", "Tables and views", "data", "one-tap"),
    a("cloudflare", "Cloudflare", "Sites, DNS and storage", "more", "one-tap"),
  ];
}

/** The people and agents an app can be shared with in the sample world. */
export const SAMPLE_GRANTEES = /** @type {const} */ ([{ who: "alex", kind: "person" }, { who: "sam", kind: "person" }, { who: "juno", kind: "agent" }, { who: "kit", kind: "agent" }]);
