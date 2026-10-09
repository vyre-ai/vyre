// @ts-check
// lib/tools-index: finding the tool for an intent in plain words ("remind me at 6", "send an email to a client"), with the same ranker as docs.find and skills.find (lib/docs-rank.js).
// Pure: the caller hands in the tools it may use (already cut by reach), this indexes each one by its name, its description and a few example asks, and returns the best three with a
// ready example call. The asks are made from the tool itself where they can be (the quoted examples in its description, its name in words); a short hand list (harness/mcp/asks.js)
// covers the tools agents reach for most. Nothing here decides who may call what: a tool the caller may not use is never handed in, so it is never found.

import { buildIndex, search, terms } from "./docs-rank.js";

/** What people say, joined to what tool descriptions say. Words, not intents: each key stands for a whole family of asks. */
export const TOOL_SYNONYMS = {
  remind: ["planner", "reminder"], reminder: ["planner"], reminders: ["planner"], todo: ["planner"], agenda: ["planner"], snooze: ["planner"], appointment: ["calendar", "event"],
  meeting: ["calendar", "event"], meetings: ["calendar", "event"], calendar: ["event"], inbox: ["mail", "message"], email: ["mail", "message"], emails: ["mail", "message"],
  thread: ["conversation"], chat: ["conversation", "thread"], conversation: ["thread"], teammate: ["team", "role"], colleague: ["team"], automation: ["flow", "flows"], automate: ["flow"],
  automations: ["flow", "flows"], password: ["vault", "credential"], passwords: ["vault", "credential"], login: ["vault", "credential"], logins: ["vault", "credential"], secret: ["vault"],
  credential: ["vault"], credentials: ["vault"], api: ["connection", "http"], account: ["connection"], money: ["payment", "gate"], payment: ["gate", "outward"], pay: ["gate", "outward"],
  file: ["files"], folder: ["files", "directory"], download: ["fetch", "files"], share: ["offer", "share"], browser: ["chrome", "page"], website: ["chrome", "page", "site"],
  screenshot: ["screen", "shot"], click: ["act", "chrome"], remember: ["memory", "recall"], forget: ["memory"], past: ["recall", "memory"], earlier: ["recall", "memory"],
  decided: ["decisions", "memory"], decision: ["decisions", "memory"], sessions: ["recall"], docs: ["docs"], documentation: ["docs"], howto: ["docs"], page: ["artifact", "docs"],
  document: ["artifact"], report: ["artifact"], dashboard: ["artifact"], spent: ["spend", "usage", "cost"], cost: ["spend", "usage"], money_spent: ["spend"], tokens: ["usage"],
  invite: ["invites", "spaces"], member: ["members", "spaces"], members: ["members", "spaces"], role: ["members", "roles"], phone: ["device", "pair", "mobile"], mac: ["device", "link"],
  pair: ["pairing", "ticket"], pairing: ["pair"], branch: ["github", "session"], commit: ["github", "session"], commits: ["github", "session"], pr: ["pull", "request", "github"],
  merge: ["pull", "github"], fork: ["thread", "branch"], interrupt: ["thread", "stop"], stop: ["stop", "interrupt"], model: ["model", "provider"], setting: ["settings"],
  version: ["build", "info", "system"], modules: ["modules", "system"], watch: ["watchers", "watcher"], notify: ["watchers"], goal: ["goals", "milestone"], milestone: ["goals"],
  people: ["members", "actors"], person: ["members"], invitation: ["invites"], invitations: ["invites"], phones: ["devices", "phone"], computers: ["devices"], devices: ["devices"], paired: ["devices", "link"],
  publicly: ["public"], public: ["public"], runs: ["runs", "run"], history: ["runs", "history"], inspect: ["get"],
  size: ["stat"], big: ["stat", "size"], large: ["stat"], apps: ["catalog", "connectors"], access: ["grant"], tell: ["watchers", "create"], alert: ["watchers", "create"], notified: ["watchers"],
  shared: ["bridges"], sharing: ["bridges", "unshare"], monday: ["calendar", "event"], tuesday: ["calendar", "event"], wednesday: ["calendar", "event"], thursday: ["calendar", "event"], friday: ["calendar", "event"],
  computer: ["computers", "screen"], screen: ["computers", "glass"], kit: ["kits", "library"], starter: ["kit", "library"], connect: ["connection", "connector"], connector: ["connection"],
};

/** The action word in a tool's name (the last part) against what people say for it. */
const VERBS = {
  show: ["list", "get", "status"], see: ["list", "get", "status"], view: ["get", "list"], display: ["get", "list"], state: ["status"], current: ["get", "status"], what: ["list"],
  change: ["set", "update", "edit", "rename"], edit: ["update", "edit"], modify: ["update", "set"], make: ["create", "add", "propose"], new: ["create", "start", "add"], write: ["define", "create", "draft"],
  undo: ["undelete", "restore", "undo"], stop: ["stop", "pause", "revoke", "unshare", "remove", "cancel"], end: ["stop", "retire"], remove: ["remove", "revoke", "delete"], delete: ["delete"],
  search: ["search", "find"], find: ["search", "find"], look: ["search", "list"], read: ["read", "get"], open: ["open", "get"], start: ["start", "create"], run: ["run", "start"],
  check: ["check", "status"], working: ["check", "status"], test: ["check", "test"], pause: ["pause"], resume: ["resume"], join: ["join", "accept"], accept: ["accept"], approve: ["approve"],
  invite: ["create", "invites"], share: ["offer", "share", "propose"], grant: ["grant"], give: ["grant", "add", "set"], connect: ["propose", "join", "connect"], install: ["install", "propose"],
  send: ["send", "request"], add: ["add"], list: ["list"], bring: ["fetch", "get"], rename: ["rename"], move: ["move", "update"], reschedule: ["update"], push: ["push"], merge: ["merge"],
};

/** Two words that are the same word in different forms: plural, agent noun ("send", "sender"), a stem ("plan", "planner"). */
const like = (/** @type {string} */ a, /** @type {string} */ b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 3);

const first = (/** @type {string} */ s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); const m = t.match(/^(.+?[.!?])(\s|$)/); return (m ? m[1] : t).slice(0, 220); };
const words = (/** @type {string} */ name) => String(name).split(/[._-]+/).join(" ");

/**
 * The asks a tool answers, made from the tool: the quoted examples in its description ("send an email to a client") and its name in words. @param {{ name: string, description?: string }} t
 * @returns {string[]}
 */
export function generatedAsks(t) {
  const d = String(t.description || "");
  /** @type {string[]} */ const out = [];
  for (const m of d.matchAll(/["“]([^"”]{6,80})["”]/g)) if (/\s/.test(m[1]) && !/[{}=]/.test(m[1])) out.push(m[1]);
  out.push(words(t.name));
  return out;
}

/**
 * A ready input for a tool, from its schema: each required property gets an example of its kind. @param {any} input
 * @returns {Record<string, any>}
 */
export function exampleArgs(input) {
  const props = (input && input.properties) || {};
  const req = Array.isArray(input && input.required) ? input.required : [];
  /** @type {Record<string, any>} */ const out = {};
  for (const k of req) {
    const p = props[k] || {};
    out[k] = p.example !== undefined ? p.example : Array.isArray(p.enum) ? p.enum[0] : p.type === "integer" || p.type === "number" ? (p.minimum ?? 1) : p.type === "boolean" ? false : p.type === "array" ? [] : p.type === "object" ? {} : `<${k}>`;
  }
  return out;
}

/** Internal and plumbing tools are real but are the last answer to an intent. */
const PLUMBING = /^(files\.drop\.|wink\.|spaces\.(moves|upgrade|identity\.(recover|code|republish)|devices|storage)|memory\.identity\.|relay\.devices\.(trust|path|drop|clear)|appmods\.hook)/;

/**
 * @param {{ name: string, also?: string, description?: string, input?: any }[]} tools `also` is the dotted name a tool has beside its MCP name
 * @param {Record<string, { asks?: string[], example?: Record<string, any>, core?: boolean }>} [hand]
 */
export function buildToolIndex(tools, hand = {}) {
  const pages = tools.map((t) => {
    const h = hand[t.name] || {};
    const asks = [...(h.asks || []), ...generatedAsks(t)];
    const desc = String(t.description || "");
    return { path: t.name, title: words(t.name), when: asks.join(". "), summary: first(desc), headings: [], body: `${t.name} ${t.also || ""} ${desc}`, set: h.core ? "core" : "rest", ref: { tool: t, example: h.example } };
  });
  return buildIndex(pages);
}

/**
 * The best tools for an intent, best first, each with a ready example call.
 * @param {ReturnType<typeof buildToolIndex>} index @param {string} query @param {{ limit?: number }} [o]
 * @returns {{ name: string, description: string, score: number, call: { tool: string, arguments: Record<string, any> } }[]}
 */
export function findTools(index, query, o = {}) {
  const want = o.limit ?? 3;
  const hits = search(index, query, { limit: Math.max(want, 40), prefer: "core", lift: 1.04, demote: PLUMBING, synonyms: TOOL_SYNONYMS });
  // A tool whose own name is what the person said ("pause" + "automation" for flows_pause) beats one that only mentions it: its name parts that the query (or a synonym of it) names lift the score.
  const said = new Set();
  for (const w of String(query).toLowerCase().split(/[^a-z0-9]+/)) { if (!w) continue; for (const t of terms(w)) said.add(t); for (const x of [...(TOOL_SYNONYMS[/** @type {keyof typeof TOOL_SYNONYMS} */ (w)] || []), ...(VERBS[/** @type {keyof typeof VERBS} */ (w)] || [])]) for (const t of terms(x)) said.add(t); }
  const spoken = [...said];
  const ranked = hits.map((h) => {
    const parts = terms(words(h.page.ref.tool.name)).filter((t) => !t.includes("_") && !t.includes("."));
    const named = (/** @type {string} */ p) => spoken.some((t) => like(t, p));
    const hit = parts.filter(named).length;
    const action = parts.length > 1 && named(parts[parts.length - 1]), head = parts.length > 1 && named(parts[0]);
    const cover = parts.length ? hit / parts.length : 0;
    return { page: h.page, score: h.score * (1 + 0.8 * cover + (action && head ? 0.35 : 0)) };
  }).sort((a, b) => b.score - a.score || (a.page.path < b.page.path ? -1 : 1)).slice(0, want);
  return ranked.map((h) => {
    const { tool, example } = h.page.ref;
    return { name: tool.name, description: first(tool.description), score: Math.round(h.score * 100) / 100, call: { tool: tool.name, arguments: example || exampleArgs(tool.input) } };
  });
}
