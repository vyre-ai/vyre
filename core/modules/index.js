// @ts-check
// modules — find modules, check their manifests, start them in order, and run their tools.
//
// Everything in Vyre is a module on one contract (docs/SPEC.md, section 5): core services,
// Harness pieces, surfaces and whatever a user installs. A module declares five things in
// module.json (does, watches, shows, needs, teaches) and exports start(ctx). The loader is the
// only place that knows how modules are wired together, which is what lets a new one appear
// everywhere it belongs without special cases.
//
// A module that fails to start is disabled and reported. It never takes the daemon down: one
// broken watcher runtime should not cost someone their search.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "../store/index.js";
import { Idempotency } from "./idempotency.js";
import { PERSON_ONLY, machineSelf, core as coreHolder, format as formatProof } from "../presence/index.js";
import { validateDecls } from "../config/settings.js";
import * as config from "../config/index.js";
import { toolEntries, checkManifestFull } from "../../packages/module-sdk/manifest.js";
import { isPerson } from "../../lib/caller.js";
import { CONTRACT, supports, moduleContract, adapterFor } from "../../packages/module-sdk/contract.js";
import { within } from "../../lib/within.js";

/** Features ctx.api.has() answers true for in this loader, inside the running contract. */
const LOADER_FEATURES = ["modules.status"];

/** Tools a tailnet device reaches without a person session: signing in, and the first passkey. */
const PERSON_FREE = new Set(["presence.person.start", "presence.enroll"]);

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
/** Vyre's own modules live here; a module installed into a home never does. */
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Vyre's own modules are the ones shipped in the repo (core, local, modules); a home's never are. */
const REPO_DIR = path.resolve(CORE_DIR, "..");
const SHIPPED = ["core", "local", "modules"].map(x => path.join(REPO_DIR, x));
/**
 * Shipped with Vyre: a module folder directly in the repo's core/, local/ or modules/, and never
 * one inside the home, even a dev home kept inside a checkout (VYRE_HOME=<repo>/.dev): a home
 * module is the person's or a third party's, whatever folder it sits in (e2e review).
 * @param {string} dir
 */
export const firstParty = dir => {
  const d = path.resolve(dir);
  if (!SHIPPED.includes(path.dirname(d))) return false;
  const home = config.home();
  return !(home !== REPO_DIR && (d + path.sep).startsWith(home + path.sep));
};
/**
 * The only caller labels a module may call under, and who may. A person's labels ("cli", "deck")
 * are never here: a module that could call as one would act as the person. The link on a Mac types
 * into a session for the person at the box as "link:box" (docs/adr/0021-box-reads-the-mac.md).
 * @type {Record<string, string[]>}
 */
// settings passes a person's change on to the module that keeps the value, as that person.
/** How long an asked tool's target (and the thread lineage) may take to answer before the call is not_asked. */
const TARGET_MS = 2000;
/** The one tool the agents module may call as the asking person: agents.ask's words and tags, heard by threads.send. @param {string} tool */
export const agentsMayRelay = tool => tool === "threads.send";
/** The per-call check on the agents module's relay: throws for any tool but threads.send. @param {string} tool @param {string} as */
export function checkAgentsRelay(tool, as) {
  if (!agentsMayRelay(tool)) throw new Error(`agents may not call ${tool} as ${as}: it relays a person to threads.send only`);
}
/** @type {Record<string, any>} */
const CALL_AS = { agents: (/** @type {string} */ as) => isPerson(as), link: ["link:box"], settings: ["cli", "local", "deck", "capsule"], mentions: (/** @type {string} */ as) => isPerson(as) || as === "module:sessions" || as === "module:assistant",
  // capsule runs a view's declared tool as the asking person (first party modules) or as the added module itself, never as anyone else.
  capsule: (/** @type {string} */ as) => isPerson(as) || /^module:[a-z][a-z0-9-]*$/.test(as),
  // connectors relays the person who asked to one thing: writing an api-credential (a module cannot write one on its own); checked per call below.
  connectors: (/** @type {string} */ as) => isPerson(as) };
/**
 * A manifest still says `"roles": ["box"]` or `["local"]` (forty-plus modules across every
 * team; ADR 0039 keeps that vocabulary rather than renaming it everywhere). `start()` is called
 * with `config.machine` -- the person's actual choice, "solo", "server" or "device" -- and this
 * is where the two meet: which manifest buckets are active for it. A raw "box" or "local" (a
 * caller, mostly tests, that still passes one directly) passes straight through unchanged.
 * @param {string} role @returns {string[]}
 */
export function roleBuckets(role, platform = process.platform) {
  if (role === "box" || role === "local") return [role];
  // Module API 1 (ADR 0047): a manifest's "mac" or "windows" is "local" on that OS only.
  if (role === "mac") return platform === "darwin" ? ["local"] : [];
  if (role === "windows") return platform === "win32" ? ["local"] : [];
  const out = [];
  if (config.isServer(role)) out.push("box");
  // A Mac chosen as the server is still, often, someone's own desk: Capsule, voice and the
  // rest of the local core stay (team-lead, 28 Sep). A Linux box never had those anyway.
  if (config.isDevice(role) || (role === "server" && platform === "darwin")) out.push("local");
  return out;
}
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
/** Who may call a tool (ADR 0047), and what an outward tool does as the person. */
const REACHES = ["anyone", "asked", "person", "modules", "hook"];
const OUTWARD = ["send", "post", "pay", "delete"];

/**
 * The SDK's added-module check, as a load reads it: the graces applied first, so only the 1.0
 * rules that keep a module inside its doors are problems (person reach, presence-free tools,
 * built in only keys, wildcards, replaces, outward on a hidden reach, the schema).
 * @param {any} m @returns {{ problems: string[], warnings: string[] }}
 */
export function addedCheck(m) {
  if (!m || typeof m !== "object" || typeof m.name !== "string") return { problems: [], warnings: [] };
  const graced = [];
  const g = { ...m };
  if (g.vyre === undefined && g.apiVersion === undefined) g.vyre = "1";
  if (g.description === undefined) { g.description = m.name; graced.push("description is missing; add one plain sentence for the install card"); }
  if (g.does && typeof g.does === "object" && Array.isArray(g.does.tools) && g.does.tools.some(t => typeof t === "string")) {
    g.does = { ...g.does, tools: g.does.tools.map(t => (typeof t === "string" ? { name: t } : t)) };
    graced.push("string tool entries are deprecated; write each as { \"name\": ..., \"reach\": ... } (vyre module upgrade does it)");
  }
  const r = checkManifestFull(g, { firstParty: false });
  return { problems: r.problems, warnings: [...graced, ...r.warnings] };
}

/** The modules a manifest requires: a list of names, or the keys of { name: range } (ADR 0047). @param {any} m */
export const requiresOf = m => (Array.isArray(m && m.requires) ? m.requires : m && m.requires && typeof m.requires === "object" ? Object.keys(m.requires) : []);

/** A version as [major, minor, patch], or null. @param {string} v */
const semver = v => { const x = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim()); return x ? [Number(x[1]), Number(x[2] || 0), Number(x[3] || 0)] : null; };
const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a version meets a range: comparators (>=, >, <=, <, =, ^, ~, or a bare version) joined by
 * spaces, all of which must hold, or * for any. null when the range can't be read.
 * @param {string} version @param {string} range @returns {boolean | null}
 */
export function satisfies(version, range) {
  const v = semver(version);
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (!v) return false;
  let ok = true;
  for (const part of parts) {
    if (part === "*" || part === "x") continue;
    const x = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.\d+){0,2})$/.exec(part);
    if (!x) return null;
    const want = /** @type {number[]} */ (semver(x[2])), c = cmp(v, want);
    const op = x[1] || "=";
    const upper = op === "^" ? (want[0] > 0 ? [want[0] + 1, 0, 0] : [0, want[1] + 1, 0]) : [want[0], want[1] + 1, 0];
    const hold = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : op === "=" ? c === 0 : c >= 0 && cmp(v, upper) < 0;
    ok = ok && hold;
  }
  return ok;
}
const VERBS = ["does", "watches", "shows", "needs", "teaches"];
/** Use counts reach vyre.db at most this often; nothing is written while nothing was used. */
const USE_FLUSH = 60_000;
/** How long one module's own stop() may take before Registry.stop() gives up on it and moves on
 * to the next (matches core/daemon/index.js's DRAIN_MS for the same reason: a hang in one place
 * must never become a hang everywhere). */
const MODULE_STOP_MS = 5_000;

/**
 * Check a manifest. Returns a list of problems; empty means valid. `firstParty` is true for a
 * module shipped with Vyre; a module from anywhere else is held to more (its settings' stores).
 * @param {any} m @param {{ firstParty?: boolean }} [opts]
 */
/**
 * Event families only their first-party owners may declare: device sync is federation's, and the
 * Gate, push, presence, said and memory families make other modules act on the person's data or
 * trust, so an added module can't emit push.proactive, gate.held and the like.
 */
export const RESERVED_EVENTS = {
  sync: ["sync"], gate: ["gate"], push: ["push", "assistant"], presence: ["presence"],
  said: ["assistant"], memory: ["memory"], "artifact-links": ["artifacts"],
  // thread.deleted wipes a chat history: only the session modules that own threads emit thread.*.
  // tailscale.changed tells the setup page the tailnet is connected: only the network module says so.
  tailscale: ["network"],
  thread: ["threads", "harness", "link", "projects", "sessions", "artifacts"],
};

export function validate(m, { firstParty = false } = {}) {
  const out = [];
  if (!m || typeof m !== "object") return ["module.json is not an object"];
  // A contract this Vyre doesn't speak is the one problem, and the module's code is never imported
  // (ADR 0047 section 8). Naming none reads as "1"; unknown keys are ignored, never a problem.
  const speaks = supports(moduleContract(m), { name: typeof m.name === "string" ? m.name : "this module" });
  if (!speaks.ok) return [speaks.message];
  // A module not shipped with Vyre is held to the added-module rules wherever it sits: added with
  // `vyre module add`, or placed in <home>/modules by hand (reviews/platform.md CR-H3). The graces
  // of a load (ADR 0047 section 8) stay: no "vyre" reads as "1", and what is only deprecated
  // (string tool entries, a missing description) warns through addedWarnings(), never fails.
  if (!firstParty) out.push(...addedCheck(m).problems);
  if (!NAME.test(String(m.name || ""))) out.push(`name "${m.name}" must be lowercase letters, digits and dashes`);
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ""))) out.push(`version "${m.version}" must be semver`);
  if (m.roles && (!Array.isArray(m.roles) || m.roles.some(r => !["box", "local", "mac", "windows"].includes(r)))) out.push("roles must be a list of box, local, mac and windows");
  if (m.requires && !Array.isArray(m.requires)) {
    // Module API 1: { name: range }, each range checked against the dependency's version at start.
    if (typeof m.requires !== "object") out.push("requires must be a list or { name: range }");
    else for (const [n, r] of Object.entries(m.requires)) {
      if (!NAME.test(n)) out.push(`requires "${n}" must be a module name`);
      if (typeof r !== "string" || satisfies("0.0.0", r) === null) out.push(`requires "${n}": "${r}" is not a version range`);
    }
  }
  for (const v of VERBS) if (m[v] !== undefined && (typeof m[v] !== "object" || Array.isArray(m[v]))) out.push(`${v} must be an object`);
  for (const e of (m.does && m.does.tools) || []) {
    // A name, or the object form of module API 1 (ADR 0047): { name, summary?, reach?, outward?, cost? }.
    const t = e && typeof e === "object" && !Array.isArray(e) ? e.name : e;
    if (typeof t !== "string") { out.push("a tool entry must be a name or { name, reach?, outward? }"); continue; }
    if (!TOOL.test(t)) out.push(`tool "${t}" must look like module.verb`);
    else if (!t.startsWith(m.name + ".")) out.push(`tool "${t}" must start with "${m.name}."`);
    if (typeof e === "object" && e.reach !== undefined && !REACHES.includes(e.reach)) out.push(`tool "${t}": reach must be one of ${REACHES.join(", ")}`);
    if (typeof e === "object" && e.outward !== undefined && !OUTWARD.includes(e.outward)) out.push(`tool "${t}": outward must be one of ${OUTWARD.join(", ")}`);
  }
  for (const e of (m.watches && m.watches.emits) || []) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(e)) out.push(`event "${e}" must look like noun.past-verb`);
    // Events that make other modules act on the person's data (sync.deleted forgets a device's
    // history) come only from the first-party module that owns them.
    const owners = RESERVED_EVENTS[e.split(".")[0]];
    if (owners && !(firstParty && owners.includes(String(m.name)))) out.push(`event "${e}" is reserved for ${owners.join(" or ")}`);
  }
  out.push(...validateDecls(String(m.name), m.settings, { firstParty, tools: toolEntries(m).map(t => t.name) }));
  // Session providers (ADR 0030): drivers the Switchboard can run a session on, besides Claude.
  const providers = m.does && m.does.providers;
  if (providers !== undefined && (!Array.isArray(providers) || providers.some(p => !NAME.test(String(p))))) out.push("does.providers must be a list of lowercase names");
  out.push(...checkCredentials(m.needs && m.needs.credentials));
  // setupTools: this module's own tools the setup channel may call (built in only, see addedCheck).
  if (m.setupTools !== undefined) {
    const own = new Set(toolEntries(m).map(t => t.name));
    if (!Array.isArray(m.setupTools) || m.setupTools.some(/** @param {any} t */ t => typeof t !== "string")) out.push("setupTools must be a list of tool names");
    else for (const t of m.setupTools) if (!own.has(t)) out.push(`setupTools "${t}" is not a tool this module declares in does.tools`);
  }
  // An asked tool's target: one internal tool of this module, answering what one call acts on (built in only, see addedCheck).
  for (const e of toolEntries(m)) {
    if (!e.target) continue;
    const own = toolEntries(m).find(x => x.name === e.target);
    if (e.reach !== "asked") out.push(`tool "${e.name}": target is for an asked tool`);
    else if (!own || !String(e.target).startsWith(String(m.name) + ".")) out.push(`tool "${e.name}": target "${e.target}" is not a tool this module declares in does.tools`);
    else if (own.reach !== "modules") out.push(`tool "${e.name}": target "${e.target}" must be reach modules, an internal tool`);
  }
  // mentions: the # picker's kinds, each naming this module's own search and resolve tools (built in only, see addedCheck).
  if (Array.isArray(m.mentions)) {
    const own = new Set(toolEntries(m).map(t => t.name));
    const kinds = new Set();
    for (const e of m.mentions) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.kind !== "string" || !/^[a-z][a-z0-9-]{1,24}$/.test(e.kind)) out.push(`mentions kind ${JSON.stringify(e.kind)} must be lowercase letters, digits and dashes, 2 to 25 characters`);
      if (typeof e.label !== "string" || !e.label || e.label.length > 40) out.push(`mentions "${e.kind}" needs a label of up to 40 characters`);
      if (e.icon !== undefined && (typeof e.icon !== "string" || !/^[a-z][a-z0-9-]{0,24}$/.test(e.icon))) out.push(`mentions "${e.kind}" icon must be a short lowercase slug`);
      if (kinds.has(e.kind)) out.push(`mentions kind "${e.kind}" is declared twice`);
      kinds.add(e.kind);
      for (const f of ["search", "resolve"]) if (typeof e[f] === "string" && !own.has(e[f])) out.push(`mentions "${e.kind}" ${f} "${e[f]}" is not a tool this module declares in does.tools`);
    }
  }
  // ADR 0047, reviews/platform.md H2: an added module replaces nothing in 0.2.
  if (!firstParty && m.replaces !== undefined) out.push("replaces: an added module can't replace one of Vyre's modules; the 0.2 allowlist of replaceable modules is empty");
  return out;
}

const NEED = /^[a-z][a-z0-9_-]{0,40}$/;
/**
 * needs.credentials (ADR 0028, decision 9a): what a module needs from the Vault, which the vault
 * lists and fills. The kind and provider words are the vault's to check; this checks the shape.
 * @param {any} list
 */
function checkCredentials(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["needs.credentials must be a list"];
  const out = [], ids = new Set();
  for (const [i, c] of list.entries()) {
    const at = `needs.credentials[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.push(`${at} must be an object`); continue; }
    if (!NEED.test(String(c.id ?? ""))) out.push(`${at}.id must be a lowercase name`);
    else if (ids.has(c.id)) out.push(`${at}.id ${c.id} is declared twice`);
    ids.add(c.id);
    for (const k of ["kind", "provider", "purpose"]) if (typeof c[k] !== "string" || !c[k]) out.push(`${at}.${k} must be a string`);
    if (c.item !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(String(c.item))) out.push(`${at}.item must be a vault item name`);
    if (c.group !== undefined && !NEED.test(String(c.group))) out.push(`${at}.group must be a lowercase name`);
    if (c.optional !== undefined && typeof c.optional !== "boolean") out.push(`${at}.optional must be true or false`);
    // multiple: one item per account, named <module>-<label> when the person connects it.
    if (c.multiple !== undefined && typeof c.multiple !== "boolean") out.push(`${at}.multiple must be true or false`);
    if (c.multiple === true && c.item !== undefined) out.push(`${at}.item cannot be set with multiple: each item is named <module>-<label>`);
  }
  return out;
}

/** The vault items a module's needs.credentials names: `item`, or `<module>-<id>`. @param {any} m */
export const credentialItems = m => (Array.isArray(m && m.needs && m.needs.credentials) ? m.needs.credentials : [])
  .filter(c => !(c && c.multiple === true)).map(c => (c && c.item) || `${m.name}-${c && c.id}`);

/** Whether an item is one of a `multiple` need's items: `<module>-<label>`. @param {any} m @param {string} name */
export const multipleItem = (m, name) => (Array.isArray(m && m.needs && m.needs.credentials) ? m.needs.credentials : [])
  .some(c => c && c.multiple === true) && String(name).startsWith(`${m.name}-`);

/**
 * Whether a module folder sits directly in one of the given roots: the firstPartyRoots an
 * in-process caller (a test standing in for Vyre's own modules) hands discover() and the Registry.
 * @param {string} dir @param {string[] | undefined} roots
 */
const inRoots = (dir, roots) => Array.isArray(roots) && roots.some(r => typeof r === "string" && path.isAbsolute(r) && path.dirname(path.resolve(dir)) === path.resolve(r));

/**
 * Every folder under the given roots that holds a module.json. firstPartyRoots: folders whose
 * modules count as Vyre's own, for tests whose fixtures stand in for a built in module. Only
 * in-process code passes it (core/daemon start's own option); config.json, the environment and
 * the command line never reach it, and vyred's own start passes none.
 * @param {string[]} roots @param {{ firstPartyRoots?: string[] }} [o]
 */
export function discover(roots, { firstPartyRoots = [] } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, "module.json");
      if (!fs.existsSync(file)) continue;
      let manifest = null, problems = [], warnings = [];
      try {
        manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const fp = firstParty(dir) || inRoots(dir, firstPartyRoots);
        problems = validate(manifest, { firstParty: fp });
        if (!fp && !problems.length) warnings = addedCheck(manifest).warnings;
      } catch (err) { problems = ["module.json unreadable: " + /** @type {Error} */ (err).message]; }
      found.push({ dir, manifest, problems, warnings });
    }
  }
  return found;
}

/** Order modules so each starts after what it requires. Cycles and missing deps are problems. */
export function order(mods) {
  const byName = new Map(mods.map(m => [m.manifest.name, m]));
  const out = [], seen = new Set(), stack = new Set(), problems = new Map();
  const visit = (m, trail) => {
    const n = m.manifest.name;
    if (seen.has(n)) return true;
    if (stack.has(n)) { problems.set(n, `requires a cycle: ${[...trail, n].join(" → ")}`); return false; }
    stack.add(n);
    for (const dep of requiresOf(m.manifest)) {
      const d = byName.get(dep);
      if (!d) { problems.set(n, `requires "${dep}", which is not available`); stack.delete(n); return false; }
      const range = Array.isArray(m.manifest.requires) ? null : m.manifest.requires[dep];
      if (range && !satisfies(d.manifest.version, range)) { problems.set(n, `requires "${dep}" ${range}, but ${dep} is ${d.manifest.version}`); stack.delete(n); return false; }
      if (!visit(d, [...trail, n])) { if (!problems.has(n)) problems.set(n, `requires "${dep}", which could not start`); stack.delete(n); return false; }
    }
    stack.delete(n); seen.add(n); out.push(m);
    return true;
  };
  for (const m of mods) visit(m, []);
  return { ordered: out, problems };
}

/**
 * A tiny JSON-schema check for tool input: types, required keys, enums. Enough to reject a bad
 * call with a readable error; a tool's own run() still validates anything subtle.
 */
export function checkInput(schema, value, where = "input") {
  if (!schema) return [];
  const out = [];
  const type = schema.type;
  const is = { object: v => v && typeof v === "object" && !Array.isArray(v), array: Array.isArray,
    string: v => typeof v === "string", number: v => typeof v === "number", integer: Number.isInteger,
    boolean: v => typeof v === "boolean" };
  if (type && is[type] && !is[type](value)) return [`${where} must be ${type}`];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${where} must be one of ${schema.enum.join(", ")}`);
  if (type === "object") {
    for (const k of schema.required || []) if (value[k] === undefined) out.push(`${where}.${k} is required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) out.push(...checkInput(s, value[k], `${where}.${k}`));
  }
  if (type === "array" && schema.items) value.forEach((v, i) => out.push(...checkInput(schema.items, v, `${where}[${i}]`)));
  return out;
}

/**
 * "module:notes" is a module; every other caller is its own kind: "cli", "local", "mcp". A caller
 * that names an agent ("mcp:agent:kit", "harness:agent:kit") is the kind before the name, so an
 * agent's MCP server is still "mcp" to every allowlist and rule. vyred has already checked the name.
 */
/**
 * The surfaces' own labels: the person at a terminal (cli, local), their Deck and Capsule, and
 * the phone app (mobile). The one list; a module that trusts a surface's label imports it rather
 * than keeping its own copy. On the socket every such label is only a claim, and vyred takes any
 * label but a model's own (mcp, harness) from under a `claude` or a thread as that session's
 * (core/daemon asTaken), whether or not it is listed here.
 */
export const SURFACE_LABELS = Object.freeze(["cli", "local", "deck", "capsule", "mobile"]);

/** Who may call a reach "person" tool: the person's own surfaces, and the owner's own devices (callerAllowed). */
const PERSON_CALLERS = Object.freeze([...SURFACE_LABELS, "tailnet"]);

export const callerKind = caller => {
  const c = String(caller);
  // "mcp:agent:<name>" and "mcp:thread:<id>" (a Vyre-owned session, ADR 0030) are both "mcp".
  return c.startsWith("module:") ? "module" : c.replace(/[\s:](agent|thread):.*$/s, "");
};

/**
 * The agent name a caller claims, in any transport shape: "mcp:agent:kit", "harness:agent:kit",
 * "cli:agent:kit", "module:agent:kit", or just "agent:kit". Null when the caller makes no such
 * claim. computers, hands-desktop and sight each used to write their own version of this regex;
 * one of them (hands-desktop's resolveAgent) matched only the narrower "mcp:agent:" shape, so a
 * claim shaped "cli:agent:kit" fell through to full trust instead of being checked at all (e2e
 * review, 2026-09-28). One parser here, so a fix to it reaches every caller at once and a new
 * module never re-derives it. This only says what the caller *claims*; the daemon's own socket
 * layer is what actually refuses an unvouched claim (ADR 0031's agent-claim work).
 *
 * A claim with no name or an odd one ("cli agent:", "cli agent:???") still counts as a claim: it
 * must never come back as "" or another value every caller's `if (claim)` treats as no claim at
 * all, which would make an empty-named claim fully trusted instead of refused (e2e review,
 * 2026-09-28: the daemon's own socket vouch fails such a claim today, but an in-process caller
 * does not go through that layer, so this helper has to fail closed on its own).
 */
export const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;
export const agentClaim = caller => {
  const m = AGENT_CLAIM.exec(String(caller ?? ""));
  return m ? m[1] || "(unnamed)" : null;
};

/**
 * May this caller use a tool with this callers list? On a box the Deck is served at the tailnet
 * address, where the names listener admits only the owner and labels the call "tailnet:<login>"
 * (ADR 0002). That is the owner's own Deck, so a tool open to "deck" is open to it; an agent's own
 * node ("tailnet:agent:<name>") is not. A "tailnet" entry opens a tool to the owner's devices only,
 * such as the phone (ADR 0018). The bare word is never a caller itself: a socket client could send
 * it as a label.
 * @param {string[]|null|undefined} callers
 */
export const callerAllowed = (callers, caller) => !callers || (callers.includes(callerKind(caller)) && callerKind(caller) !== "tailnet")
  || (callers.includes("deck") && ownerDevice(caller))
  || (callers.includes("tailnet") && ownerDevice(caller));

/**
 * The box's owner on their own device at the box's address: the tailnet listener names only the
 * verified owner `tailnet:<login>` (core/names/service.js); a guest is `tailnet-guest:` and an
 * agent's node `tailnet:agent:`. The owner's Deck and phone always arrive this way on a box.
 */
export const ownerOverTailnet = caller => /^tailnet:(?!agent:)./.test(String(caller));

/**
 * The owner on one of their own devices, however it reached the box: over the tailnet
 * (`tailnet:<owner>`), or a device paired through the relay (`device:<id>`, ADR 0026), which only
 * the relay module's listener names. A person who may ask; presence still decides every
 * human-only call. A guest, an agent's node and a socket label are never one.
 */
export const ownerDevice = caller => ownerOverTailnet(caller) || /^device:[a-z2-7]{16}$/.test(String(caller));

/** Shipped in the repo (core, local, modules), not added to a home's modules folder. @param {string} dir @param {any} paths */
const inRepo = (dir, paths) => {
  const d = path.resolve(dir), home = paths && paths.modules ? path.resolve(paths.modules) + path.sep : null;
  return d.startsWith(path.dirname(CORE_DIR) + path.sep) && !(home && d.startsWith(home));
};

export class Registry {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, events: any, config: any, log: (m: string, x?: any) => void,
   *           rules?: (call: { tool: string, input: any, caller: string }) => Promise<{ allow: boolean, reason?: string }>,
   *           handler?: (policy: any) => (req: any, res: any, caller: string) => Promise<void>, paths?: any,
   *           upgrader?: (policy: any) => (req: any, socket: any, head: any, caller: string) => void,
   *           presence?: import("../presence/index.js").Presence, coreKeys?: any }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** Folders an in-process caller says hold Vyre's own modules (discover's firstPartyRoots). */
    this.firstPartyRoots = Array.isArray(deps && deps.firstPartyRoots) ? deps.firstPartyRoots.filter(r => typeof r === "string" && path.isAbsolute(r)) : [];
    /** @type {Map<string, { module: string, description: string, input: any, run: Function }>} */
    this.tools = new Map();
    /** @type {Map<string, { manifest: any, dir: string, state: string, error?: string, handle?: any }>} */
    this.modules = new Map();
    /** @type {Map<string, { module: string, handler: Function }>} WebSocket paths, keyed "<module>/<name>". */
    this.upgrades = new Map();
    /** @type {Map<string, (req: any, res: any, at: { caller: string, url: URL }) => any>} */
    this.routes = new Map();
    /** What each route declared: read-only, or the writing methods it answers. @type {Map<string, { readOnly: boolean, methods: string[] }>} */
    this.routeInfo = new Map();
    /** @type {Map<string, { module: string, driver: any }>} session providers (ADR 0030), by name */
    this.providers = new Map();
    /** A retried write runs once (ADR 0029, R2). */
    this.idempotency = deps && deps.db ? new Idempotency(deps.db) : null;
    // How often each module's tools were used by a person, a surface or a model (never by another
    // module or a webhook), and when last: what the hub and `vyre modules` show beside each one.
    // Kept in memory, loaded from and written to one kernel table. The loader owns it, so it is
    // not one module's migration.
    /** @type {Map<string, { calls: number, lastUsed: number }>} */
    this.use = new Map();
    /** @type {Set<string>} modules whose count changed since the last write */
    this.dirty = new Set();
    /** @type {NodeJS.Timeout | null} */
    this.flushTimer = null;
    if (deps && deps.db) {
      try {
        deps.db.exec("CREATE TABLE IF NOT EXISTS modules_use (module TEXT PRIMARY KEY, calls INTEGER NOT NULL, last_used INTEGER)");
        for (const r of /** @type {any[]} */ (deps.db.prepare("SELECT module, calls, last_used FROM modules_use").all())) {
          this.use.set(String(r.module), { calls: Number(r.calls) || 0, lastUsed: Number(r.last_used) || 0 });
        }
      } catch (e) { deps.log && deps.log(`module use counts unavailable: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** Vyre's own: shipped in the repo, or in a firstPartyRoots folder an in-process caller named. @param {string} dir */
  isFirstParty(dir) {
    return firstParty(dir) || inRoots(dir, this.firstPartyRoots);
  }

  /**
   * Count one use of a module's tool. The write waits: one timer, armed by the first change and
   * cleared by the write, so an idle vyred has nothing scheduled at all.
   * @param {string} module
   */
  countUse(module) {
    const u = this.use.get(module) || { calls: 0, lastUsed: 0 };
    this.use.set(module, { calls: u.calls + 1, lastUsed: Date.now() });
    this.dirty.add(module);
    if (!this.flushTimer && this.deps && this.deps.db) {
      this.flushTimer = setTimeout(() => this.flushUse(), USE_FLUSH);
      this.flushTimer.unref();
    }
  }

  /** Write the changed use counts. A closed or read-only database only costs the counts since. */
  flushUse() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const db = this.deps && this.deps.db;
    if (!db || !this.dirty.size) return;
    const names = [...this.dirty];
    this.dirty.clear();
    try {
      const put = db.prepare("INSERT INTO modules_use (module, calls, last_used) VALUES (?, ?, ?) ON CONFLICT(module) DO UPDATE SET calls = excluded.calls, last_used = excluded.last_used");
      for (const n of names) { const u = this.use.get(n); if (u) put.run(n, u.calls, u.lastUsed || null); }
    } catch { /* the counts stay in memory for status(); the next change tries again */ }
  }

  /** Start every discovered module that is enabled for this machine's role. `platform` is
   * injectable (default process.platform) so a test can cover the darwin server case on any CI
   * machine, same as roleBuckets() and core/config's defaults(). */
  async start(found, { role, enable = [], disable = [], platform = process.platform }) {
    /** @type {Map<string, string>} the # kinds offered so far, by module */
    const mentionKinds = new Map();
    // The names of the modules shipped with Vyre in this start, on or off on this machine: an added module can
    // never load under one, so it can't answer another module's tools (names.*, network.*) from first party code.
    const shipped = new Set(found.filter(x => x && x.manifest && typeof x.manifest.name === "string" && this.isFirstParty(x.dir)).map(x => x.manifest.name));
    for (const f of found) {
      const name = f.manifest && f.manifest.name;
      // A module with a problem never starts, but it never disappears without a word either: it
      // used to (a camelCase tool or event name failed validate() and the whole module just
      // was not there, with no line in the log to say why - found only by calling discover() by
      // hand). Every problem, and the two below, are logged at warn level as they happen, and
      // status() (vyre modules, /v1/modules) already carries the same reason for later.
      // Warnings (unknown keys, deprecated usages) are said once per start and never stop a load.
      for (const w of f.warnings || []) this.deps.log(`warn: module ${name || f.dir}: ${w}`);
      if (name && shipped.has(name) && !this.isFirstParty(f.dir)) {
        const error = `name "${name}" belongs to a module shipped with Vyre; an added module can't load under it, on or off`;
        this.modules.set(`${name}@${f.dir}`, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name}@${f.dir} invalid: ${error}`);
        continue;
      }
      if (f.problems.length) {
        const error = f.problems.join("; ");
        // An invalid copy never takes the row of a module already loaded under its name, and one that shares a shipped module's name never gets here in any order (the shipped-names rule above).
        this.modules.set(name && !this.modules.has(name) ? name : name ? `${name}@${f.dir}` : f.dir, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name || f.dir} invalid: ${error}`);
        continue;
      }
      const roles = f.manifest.roles || ["box", "local"];
      // "mac" and "windows" are "local" on that OS only (roleBuckets); box and local are themselves.
      const here = roleBuckets(role, platform);
      const on = !disable.includes(name) && (roles.some(r => (r === "mac" || r === "windows" ? roleBuckets(r, platform) : [r]).some(b => here.includes(b))) || enable.includes(name));
      // Two modules with one name: the first found wins (Vyre's own folders come before the
      // user's), and the other is reported, never silently dropped. A user's module named like a
      // core one once vanished without a word, and so did every tool it offered.
      // The exception is a name two of Vyre's own modules share on purpose for different machines
      // (the box's chrome and the Mac's chrome): a copy that is not on for this machine steps aside
      // for one that is, and stays listed as off, so which one runs never depends on folder order.
      if (this.modules.has(name)) {
        const prev = this.modules.get(name);
        const mine = this.isFirstParty(f.dir), theirs = this.isFirstParty(prev.dir);
        /** @param {{ manifest: any, dir: string }} rec @param {string} error */
        const reject = (rec, error) => { this.modules.set(`${name}@${rec.dir}`, { manifest: rec.manifest, dir: rec.dir, state: "invalid", error }); this.deps.log(`warn: module ${name}@${rec.dir} invalid: ${error}`); };
        // The two "added vs Vyre" branches below cannot be reached today: the shipped-names check at the top of the loop already sends an added copy of a
        // shipped name to `name@dir` as invalid, in either folder order. They stay as defence in depth; the invariant lives in that top check.
        if (mine && !theirs) {
          // Vyre's own module always owns its name, whatever the folder order: an added module found first steps aside.
          reject(prev, `a Vyre module named ${name} owns that name; this one is ignored`);
          this.modules.delete(name);
        } else if (!mine && theirs) {
          // An added module never takes or replaces a Vyre module's name, whether that one is on or off here.
          reject({ manifest: f.manifest, dir: f.dir }, `a Vyre module named ${name} owns that name; this one is ignored`);
          continue;
        } else if (!on) {
          this.modules.set(`${name}@${f.dir}`, { manifest: f.manifest, dir: f.dir, state: "off" });
          continue;
        } else if (mine && theirs && prev.state === "off") {
          this.modules.set(`${name}@${prev.dir}`, prev);
        } else {
          reject({ manifest: f.manifest, dir: f.dir }, `a module named ${name} is already loaded from ${prev.dir}; this one is ignored`);
          continue;
        }
      }
      // One provider per # kind: the first module found keeps it, and a later one that claims it fails.
      const taken = (Array.isArray(f.manifest.mentions) ? f.manifest.mentions : []).map(e => [e && e.kind, mentionKinds.get(e && e.kind)]).find(([, by]) => by && by !== name);
      if (taken) {
        const error = `mentions kind "${taken[0]}" is already offered by ${taken[1]}`;
        this.modules.set(name, { manifest: f.manifest, dir: f.dir, state: "invalid", error });
        this.deps.log(`warn: module ${name} invalid: ${error}`);
        continue;
      }
      for (const e of Array.isArray(f.manifest.mentions) ? f.manifest.mentions : []) if (e && e.kind) mentionKinds.set(e.kind, name);
      this.modules.set(name, { manifest: f.manifest, dir: f.dir, state: on ? "pending" : "off" });
    }
    const candidates = found.filter(f => { const r = this.modules.get(f.manifest && f.manifest.name); return r?.state === "pending" && r.dir === f.dir; });
    const { ordered, problems } = order(candidates);
    for (const [n, why] of problems) { Object.assign(this.modules.get(n), { state: "failed", error: why }); this.deps.log(`warn: module ${n} invalid: ${why}`); }
    for (const f of ordered) await this.startOne(f);
    return this.status();
  }

  async startOne(f) {
    const m = f.manifest, rec = this.modules.get(m.name);
    const failedDep = requiresOf(m).find(d => this.modules.get(d)?.state !== "running");
    if (failedDep) { Object.assign(rec, { state: "failed", error: `requires "${failedDep}", which is not running` }); return; }
    try {
      const entry = path.join(f.dir, m.main || "index.js");
      // Every module goes through the adapter for the contract it names (compat/v<major>.js, the
      // identity for contract 1 today), so a later major can keep it running unchanged.
      rec.contract = moduleContract(m);
      const adapter = adapterFor(rec.contract);
      if (m.apiVersion !== undefined) this.deps.log(`warn: module ${m.name} uses apiVersion, which is deprecated; use "vyre": "${m.apiVersion}"`);
      const mod = (await import(pathToFileURL(entry).href)).default;
      if (!mod || typeof mod.start !== "function") throw new Error("entry file must export default { start(ctx) }");
      rec.handle = await mod.start(adapter.context(this.context(adapter.manifest(m))));
      rec.state = "running";
      this.deps.log(`module ${m.name} ${m.version} running`);
    } catch (e) {
      Object.assign(rec, { state: "failed", error: /** @type {Error} */ (e).message });
      for (const [t, def] of this.tools) if (def.module === m.name) this.tools.delete(t);
      for (const [k, u] of this.upgrades) if (u.module === m.name) this.upgrades.delete(k);
      for (const [k] of this.routes) if (k.startsWith(`/v1/${m.name}/`)) { this.routes.delete(k); this.routeInfo.delete(k); }
      this.deps.log(`module ${m.name} failed to start: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** What a module gets. It sees only what its manifest declared. */
  context(m) {
    const { db, events, config, log, paths } = this.deps;
    // Tool names from either form of does.tools, with the reach and outward an object entry declares.
    const entries = new Map(toolEntries(m).map(e => [e.name, e]));
    const objectForm = new Set(((m.does && m.does.tools) || []).filter(e => e && typeof e === "object").map(e => e.name));
    const declared = new Set(entries.keys());
    const needs = m.needs || {};
    /** A door used without its one declaration (ADR 0047 section 3). @param {string} why */
    const undeclared = why => Object.assign(new Error(`${m.name}: ${why}`), { code: "undeclared" });
    const firstPartyRec = () => { const r = this.modules.get(m.name); return Boolean(r && this.isFirstParty(r.dir)); };
    /**
     * A ctx door onto its owning tool, as module:<name>. The door has checked its own declaration,
     * so default-deny doesn't apply. When the owner isn't running on this Vyre, the answer is
     * { error: { code: "not_available" } } naming the tool, never a crash.
     * @param {string} tool @param {any} input
     */
    const door = async (tool, input) => {
      const r = await this.call(tool, input, `module:${m.name}`, { door: true });
      if (r.error && r.error.code === "no_such_tool") return { error: { code: "not_available", message: `${tool} isn't running on this Vyre yet` } };
      return r;
    };
    /** The same, for a member that answers a value: a refusal throws, with its code. @param {string} tool @param {any} input */
    const doorValue = async (tool, input) => {
      const r = await door(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    };
    const spendDeclared = member => { if (!needs.spend) throw undeclared(`${member}, but needs.spend declares no daily cap`); };
    // The ctx members that reach outside the module (ADR 0047 section 3), each held to its one
    // declaration and made as a call onto the tool that owns it. Until that owner ships, the
    // member answers not_available (docs/MODULES.md marks which are there now).
    const setting = key => {
      const d = (Array.isArray(m.settings) ? m.settings : []).find(x => x && x.key === key);
      if (!d) throw undeclared(`used setting ${key}, which its manifest does not declare`);
      return d;
    };
    const doors = {
      // Its own declared settings, through the settings hub; without the hub, the declared default.
      settings: {
        get: async (key, o = {}) => {
          const d = setting(key);
          const r = await door("settings.get", { key, ...(o.project ? { project: o.project } : {}) });
          if (r.error && r.error.code === "not_available") return d.default;
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r.data && r.data.value !== undefined ? r.data.value : d.default;
        },
        set: async (key, value, o = {}) => {
          const d = setting(key);
          if (d.confirm !== undefined || d.security !== undefined) throw Object.assign(new Error(`${key} asks the person before a change; a module can't set it`), { code: "denied" });
          await doorValue("settings.write", { key, value, ...(o.project ? { project: o.project } : {}) });
        },
        on: (key, fn) => {
          setting(key);
          return events.on("settings.changed", e => { const p = e && e.payload; if (p && p.key === key) { try { fn(p.value, { key, ...(p.project ? { project: p.project } : {}) }); } catch {} } });
        },
      },
      push: {
        offer: async n => {
          if (!n || typeof n.kind !== "string" || !((m.shows && m.shows.notices) || []).includes(n.kind)) throw undeclared(`ctx.push.offer a ${n && n.kind} notice, which shows.notices does not list`);
          const r = await doorValue("push.offer", { ...n, from: `module:${m.name}` });
          return r === "deferred" || (r && r.deferred) ? "deferred" : "sent";
        },
      },
      undo: { record: async e => door("undo.record", { ...e, from: `module:${m.name}` }) },
      connections: {
        call: async (provider, tool, input = {}) => {
          if (!((needs.connections) || []).some(c => c && c.provider === provider)) throw undeclared(`called the ${provider} connection, which needs.connections does not declare`);
          return door("mcp.call", { server: provider, tool, arguments: input });
        },
      },
      // Uncredentialed reads need the module host's resolver (private addresses refused after DNS
      // and on every redirect, ADR 0047 section 5). Until the host lands there is no safe way to
      // make one from vyred, so fetch refuses: not_available.
      fetch: async (url, init = {}) => {
        const method = String((init && init.method) || "GET").toUpperCase();
        if (!["GET", "HEAD"].includes(method) || (init && init.body !== undefined)) throw Object.assign(new Error("ctx.fetch sends GET or HEAD with no body; to send data use ctx.vault.request or an outward tool"), { code: "method_not_allowed" });
        let host = "";
        try { host = new URL(url).hostname; } catch {}
        if (!((needs.network) || []).some(h => { const n = String(h).split(":")[0]; return n.startsWith("*.") ? host.endsWith(n.slice(1)) : host === n; })) throw undeclared(`fetched ${host}, which needs.network does not list`);
        throw Object.assign(new Error("ctx.fetch arrives with the module host; it isn't available in this Vyre yet"), { code: "not_available" });
      },
      ask: async (prompt, o = {}) => {
        spendDeclared("ctx.ask");
        // Every ask is billed against the module's cap, so without core/spend there is no ask.
        const check = await door("spend.check", { module: m.name, purpose: o.purpose, capUsd: needs.spend.dailyUsd });
        if (check.error) return check;
        if (check.data && check.data.ok === false) return { error: { code: "capped", message: `${m.name} reached its daily cap` } };
        const r = await door("threads.quick", { purpose: "helper", prompt: String(prompt) });
        if (r.error) return r;
        const usd = Number(r.data && r.data.cost_usd) || 0;
        await door("spend.record", { module: m.name, usd, purpose: `module:${m.name}/${o.purpose}` });
        return { text: String((r.data && r.data.text) || ""), usd };
      },
      spend: {
        record: async e => { spendDeclared("ctx.spend.record"); return doorValue("spend.record", { ...e, module: m.name }); },
        check: async purpose => { spendDeclared("ctx.spend.check"); return doorValue("spend.check", { module: m.name, purpose, capUsd: needs.spend.dailyUsd }); },
      },
      gate: {
        request: async req => {
          if (!((needs.tools) || []).includes("gate.request")) throw undeclared("ctx.gate.request, but needs.tools does not list gate.request");
          return doorValue("gate.request", req);
        },
      },
    };
    /** vault.request: a vendor call with a credential it never sees (vault P5). @param {string} id @param {any} req */
    const vaultRequest = async (id, req = {}) => {
      if (!((needs.credentials) || []).some(c => c && c.id === id)) throw undeclared(`asked the vault for ${id}, which needs.credentials does not declare`);
      // module and credential come last, so nothing in the request can name another (reviews N1).
      return doorValue("vault.request", { ...req, module: m.name, credential: id });
    };
    return {
      name: m.name, version: m.version, config, paths,
      // The contract this Vyre speaks, and feature tests for additions inside the major.
      api: { version: CONTRACT.current, has: (/** @type {string} */ f) => LOADER_FEATURES.includes(String(f)) },
      // Every running module's declared settings (module.json "settings"), for the settings
      // module to serve. Manifests are public; a module switched off takes its settings with it.
      declaredSettings: () => [...this.modules.entries()].filter(([, r]) => r.state === "running" && r.manifest && Array.isArray(r.manifest.settings))
        // module and firstParty come from the loader, after the declaration, so a manifest can't claim them.
        .flatMap(([name, r]) => r.manifest.settings.map(d => ({ ...d, module: name, firstParty: this.isFirstParty(r.dir) }))),
      // The tools shipped modules put on the pre-claim setup channel (module.json "setupTools"),
      // for the relay to build its allowlist from. Only a shipped module's field counts, only for a
      // tool it declares and owns, and never a relay, presence or vault tool: an added module's field is ignored.
      declaredSetupTools: () => [...this.modules.entries()]
        .filter(([, r]) => r.state === "running" && r.manifest && Array.isArray(r.manifest.setupTools) && this.isFirstParty(r.dir))
        .flatMap(([name, r]) => r.manifest.setupTools.filter((/** @type {any} */ t) => typeof t === "string" && t.startsWith(name + ".") && toolEntries(r.manifest).some(e => e.name === t) && !/^(relay|presence|vault)\./.test(t))),
      // Every running module's teaches.tips, for the tips module to choose from (core/tips). Tips
      // are plain text a module chose to show; the tips module checks them, never this loader.
      // firstParty: shipped in the repo, so its tips follow Vyre's version, not the module's own.
      declaredTips: () => [...this.modules.entries()]
        .filter(([, r]) => r.state === "running" && r.manifest && r.manifest.teaches && Array.isArray(r.manifest.teaches.tips))
        .map(([name, r]) => ({ module: name, version: r.manifest.version, firstParty: inRepo(r.dir, paths), tips: r.manifest.teaches.tips })),
      // The module's namespace in vyre.db: migrations are bound to its name, so its tables must
      // carry that name. Reads may join any table; writes to another module's tables go through
      // that module's tools.
      store: { db, migrate: steps => migrate(db, m.name, steps) },
      // A function for built in callers, with the levels module API 1 names (ADR 0047 section 3).
      log: Object.assign((msg, extra) => log(`[${m.name}] ${msg}`, extra), {
        info: (msg, extra) => log(`[${m.name}] ${msg}`, extra),
        warn: (msg, extra) => log(`warn: [${m.name}] ${msg}`, extra),
        error: (msg, extra) => log(`error: [${m.name}] ${msg}`, extra),
        debug: (msg, extra) => log(`debug: [${m.name}] ${msg}`, extra),
      }),
      events: {
        emit: (type, payload, where) => {
          const allowed = (m.watches && m.watches.emits) || [];
          if (!allowed.includes(type)) throw new Error(`${m.name} emitted ${type}, which its manifest does not declare under watches.emits`);
          return events.emit(m.name, type, payload, where);
        },
        on: (pattern, fn) => events.on(pattern, fn),
        since: (id, opts) => events.since(id, opts),
        // The cursor a read is current to (ADR 0029 R1): a view that loads through a tool, then
        // follows the stream from this id, has no gap.
        latestId: () => events.latestId(),
        // Delete this module's own redundant events (see Events.prune): only types it declares
        // under watches.emits, and only rows it emitted itself.
        prune: (type, opts = {}) => {
          const allowed = (m.watches && m.watches.emits) || [];
          if (!allowed.includes(type)) throw new Error(`${m.name} pruned ${type}, which its manifest does not declare under watches.emits`);
          return events.prune({ ...opts, type, source: m.name });
        },
      },
      // Vault items, one at a time, only those the manifest declares under needs.vault. The value
      // comes from the vault module's internal vault.release tool, which only modules can call,
      // and which sees which module asked. A "per-<thing>" entry ("per-watcher", "per-agent",
      // "per-sender") declares a module that fetches on behalf of things it runs, whose items are
      // named at run time; it must check each one's own declaration, and the grant still decides.
      // `field` picks one field of an item (a login's password, say); `watcher` is for the
      // watcher runtime, whose grants are per watcher.
      ...doors,
      vault: {
        request: vaultRequest,
        fetch: async (name, { field, watcher } = {}) => {
          const declared = [...((m.needs && m.needs.vault) || []), ...credentialItems(m)];
          if (!declared.includes(name) && !declared.some(d => d.startsWith("per-")) && !multipleItem(m, name)) throw new Error(`${m.name} asked the vault for ${name}, which its manifest does not declare under needs.vault or needs.credentials`);
          const r = await this.call("vault.release", { name, ...(field ? { field } : {}), ...(watcher ? { watcher } : {}) }, `module:${m.name}`, { door: true });
          if (r.error) throw new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message);
          return r.data && r.data.value;
        },
      },
      // Facts for the curator's queue, of the kinds declared under teaches.memory. Memory decides
      // what to keep; a module never writes Memory's tables. Without Memory running, a no-op.
      memory: {
        // A memory row through iq's memory.write, of a kind declared under teaches.memory. vyred
        // sets from, and an added module's rows are always untrusted (ADR 0047 section 3).
        write: async row => {
          const kind = row && row.kind;
          if (!((m.teaches && m.teaches.memory) || []).includes(kind)) throw undeclared(`ctx.memory.write a ${kind}, which teaches.memory does not list`);
          const fp = firstPartyRec();
          return door("memory.write", { ...row, from: `module:${m.name}`, ...(fp ? {} : { untrusted: true }) });
        },
        teach: async (kind, fact) => {
          const declared = (m.teaches && m.teaches.memory) || [];
          if (!declared.includes(kind)) throw new Error(`${m.name} taught ${kind}, which its manifest does not declare under teaches.memory`);
          const r = await this.call("memory.teach", { kind, fact, from: m.name }, `module:${m.name}`, { door: true });
          return !r.error;
        },
      },
      // Another module's tool, through the same path as every caller: input checked, rules run.
      // This is the only way one module uses another; never import its files.
      // `as` calls under another caller label: only a core module, and only a label CALL_AS
      // gives it. A manifest cannot grant this, so a module installed into a home never can.
      call: (tool, input, opts) => {
        const as = opts && opts.as;
        const rec = this.modules.get(m.name);
        // firstParty: the loader's word that this module ships in the repo, for a tool that must
        // trust a first-party caller only (a home module could take a free name). Same mechanism
        // as memory-iq's 2ecf79ba (reviewer-cleared, 0.1.1 batch) — kept identical, not a second one.
        const fp = Boolean(rec && this.isFirstParty(rec.dir));
        // An added module calls only what needs.tools names, one by one: module.* is for Vyre's
        // own. Its own tools need no entry (reviews/platform.md CR-H2, as testing.js does).
        // A context with no registry row (the docs harvest builds one to read tool schemas) is no
        // module the registry started; every started module has its row before start() runs.
        if (!as && rec && !fp && !declared.has(tool) && !((m.needs && m.needs.tools) || []).includes(tool)) {
          return Promise.reject(Object.assign(new Error(`${m.name} called ${tool}, which needs.tools does not list`), { code: "undeclared" }));
        }
        // opts.onPartial: a tool that streams (threads.quick with stream: true) hands its partial text to
        // this function, on this call only. Never the events bus, and never over a connection.
        if (!as) return this.call(tool, input, `module:${m.name}`, { firstParty: fp, ...(opts && typeof opts.onPartial === "function" ? { partial: opts.onPartial } : {}) });
        // The capsule module sits in local/capsule (the Mac app's), and is first party there.
        const core = Boolean(rec && (path.resolve(rec.dir).startsWith(CORE_DIR + path.sep) || (m.name === "capsule" && fp)));
        const allowed = /** @type {any} */ (CALL_AS)[m.name];
        if (!core || !(typeof allowed === "function" ? allowed(String(as)) : (allowed || []).includes(String(as)))) throw new Error(`${m.name} may not call ${tool} as ${as}`);
        // mentions replays the asking person to a provider's search tool, never to any other tool.
        if (m.name === "connectors" && !(tool === "vault.put" && input && typeof input === "object" && input.kind === "api-credential")) throw new Error(`connectors may not call ${tool} as ${as}: it relays a person to vault.put for an api-credential only`);
        // agents relays the asking person to threads.send alone (agents.ask's tags), never to any other tool.
        if (m.name === "agents") checkAgentsRelay(tool, String(as));
        if (m.name === "capsule" && !this.capsuleMayCall(String(as), tool)) throw new Error(`capsule may not call ${tool} as ${as}: no Capsule view of that module declares it`);
        if (m.name === "mentions" && !this.mentionTools(String(as).startsWith("module:") ? "resolve" : "search").has(tool)) throw new Error(`mentions may not call ${tool} as ${as}: no first-party provider names it`);
        // settings relays a person only to the tools first-party modules declared as their own
        // settings' getters and setters, never to any other tool (e2e review, HIGH 2).
        if (m.name === "settings" && !this.settingTools().has(tool)) throw new Error(`settings may not call ${tool} as ${as}: no first-party setting names it`);
        return this.call(tool, input, String(as), m.name === "capsule" && opts.asked && typeof opts.asked === "object" ? { asked: opts.asked } : {});
      },
      // A long-lived connection (a WebSocket) at /v1/streams/<module>/<name>, for what a tool call
      // cannot carry: Glass streams a screen this way. The name must be declared under
      // shows.streams. The handler gets the raw upgrade (req, socket, head) and the caller, and
      // owns the socket from then on, including closing it when the module stops.
      upgrade: (name, handler) => {
        const declared = (m.shows && m.shows.streams) || [];
        if (!declared.includes(name)) throw new Error(`${m.name} registered stream ${name}, which its manifest does not declare under shows.streams`);
        if (typeof handler !== "function") throw new Error(`stream ${name} needs a handler`);
        this.upgrades.set(`${m.name}/${name}`, { module: m.name, handler });
      },
      // vyred's router, for a module that opens a listener of its own (names, onboard). The module
      // establishes the caller; the policy limits what that listener can reach. See ADR 0002.
      // What every module is, read only: the rows GET /v1/modules gives, including what each
      // declares (commands, connections, suggest, notices, emits) and how much it is used. A copy,
      // so nothing a module does to it changes the registry.
      modules: {
        status: () => structuredClone(this.status()),
        // The tools a caller may use, as GET /v1/tools gives them to it. For a module that lists
        // what a surface can run (commands.list), never for deciding a call: the registry does that.
        tools: caller => structuredClone(this.listTools(caller ? String(caller) : undefined)),
      },
      // The box's keys held by vyre-core (lib/vyre-core-keys.js), for the relay module alone: its dh
      // and signature would let any module that held them speak as the box. Null where core has none.
      coreKeys: m.name === "relay" && firstParty(String((this.modules.get(m.name) || {}).dir || "")) ? this.deps.coreKeys || null : null,
      handler: policy => { if (!this.deps.handler) throw new Error("this vyred has no router to hand out"); return this.deps.handler(policy); },
      // The same for WebSocket upgrades (/v1/streams/...): (req, socket, head, caller). Without it
      // a module's listener cannot carry a stream, and Glass over the tailnet never connected.
      upgrader: policy => { if (!this.deps.upgrader) throw new Error("this vyred has no stream router to hand out"); return this.deps.upgrader(policy); },
      // A tool on the user's box, from a module on the Mac: the link module carries it over the
      // tailnet. Resolves like call(), and to { error: { code: "box_unreachable" } } when the
      // box cannot be reached, so a caller can fall back to what this machine has.
      remote: async (tool, input = {}) => {
        const r = await this.call("link.remote", { tool, input }, `module:${m.name}`, { door: true });
        return r.error && r.error.code === "no_such_tool" ? { error: { code: "no_link", message: "this machine is not linked to a box" } } : r.data && r.data.result ? r.data.result : r;
      },
      // A raw HTTP route on vyred's socket at /v1/<module>/<name>, for what a tool cannot carry:
      // a stream. The route sees the caller the router established; it never reads one itself.
      // `opts` is required: { readOnly: true } for a route that only reads (a GET answers with no side effect), or { methods: ["PUT"] } for
      // one that writes and answers only those methods, never GET. A route is reached with whatever a request carries, and a GET
      // can be made by any page the person opens, so one that changes something must not answer GET (reviews/platform.md, fetch-site rule).
      route: (name, fn, opts) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`route ${name} must be lowercase letters, digits and dashes`);
        const writes = opts && Array.isArray(opts.methods) && opts.methods.length > 0 && opts.methods.every(x => ["POST", "PUT", "PATCH", "DELETE"].includes(x));
        if (!(opts && (opts.readOnly === true || writes))) throw new Error(`route ${m.name}/${name} must say { readOnly: true } or { methods: ["PUT"] }`);
        if (opts.readOnly === true && writes) throw new Error(`route ${m.name}/${name} is read-only or writes, not both`);
        const at = `/v1/${m.name}/${name}`;
        if (this.routes.has(at)) throw new Error(`route ${at} is already registered`);
        this.routes.set(at, fn);
        this.routeInfo.set(at, { readOnly: opts.readOnly === true, methods: writes ? [...opts.methods] : ["GET", "HEAD"] });
      },
      // A session provider: a driver the Switchboard runs sessions on (core/sessions/provider.js).
      // Declared under does.providers; it must pass core/sessions/conformance.js.
      provider: (name, driver) => {
        const mine = (m.does && m.does.providers) || [];
        if (!mine.includes(name)) throw new Error(`${m.name} registered provider ${name}, which its manifest does not declare under does.providers`);
        if (this.providers.has(name)) throw new Error(`provider ${name} is already registered`);
        if (!driver || typeof driver.run !== "function") throw new Error(`provider ${name} needs a run function`);
        this.providers.set(name, { module: m.name, driver });
      },
      // What every module is, read only: the rows GET /v1/modules gives, including what each
      // declares (commands, connections, suggest, notices, emits) and how much it is used. A copy,
      // so nothing a module does to it changes the registry.
      modules: {
        status: () => structuredClone(this.status()),
        // The tools a caller may use, as GET /v1/tools gives them to it. For a module that lists
        // what a surface can run (commands.list), never for deciding a call: the registry does that.
        tools: caller => structuredClone(this.listTools(caller ? String(caller) : undefined)),
      },
      providers: {
        get: name => { const p = this.providers.get(String(name)); return p ? p.driver : null; },
        list: () => [...this.providers.keys()],
      },
      tool: (name, def) => {
        if (!declared.has(name)) throw new Error(`${m.name} registered tool ${name}, which its manifest does not declare under does.tools`);
        if (this.tools.has(name)) throw new Error(`tool ${name} is already registered`);
        if (typeof def.run !== "function") throw new Error(`tool ${name} needs a run function`);
        // internal: only other modules may call it (never Claude, the CLI or a surface), and it is
        // left out of every listing. vault.release is the reason this exists.
        // callers: the kinds of caller that may use it ("cli", "local", "mcp", "module"); a
        // tool is refused to, and left out of the listing for, any other. Omitted means all.
        // hook: reachable only as vyred's webhook route POST /v1/<module>/<name>/hook (caller
        // "hook"), and left out of every listing. The tool checks its own secret.
        // core: vyre-core answers it on this Mac and checks its proof itself (ADR 0040 phase 2);
        // only a first-party module may say so, since it turns vyred's own presence check off.
        if (def.core && !firstParty(m.dir)) throw new Error(`${m.name} is not one of Vyre's own modules, so ${name} can't be a vyre-core tool`);
        // A declared reach (ADR 0047) sets the same checks: modules is internal, hook is the webhook
        // route, and person is the person's own surfaces and devices only. anyone and asked stay
        // open here; the asked check and outward routing are later build steps (plans/platform.md).
        const e = entries.get(name), reach = e ? e.reach : "anyone";
        this.tools.set(name, { module: m.name, description: def.description || "", input: def.input || { type: "object" }, run: def.run,
          internal: Boolean(def.internal) || reach === "modules",
          callers: reach === "person" ? [...PERSON_CALLERS] : Array.isArray(def.callers) ? def.callers : null,
          hook: Boolean(def.hook) || reach === "hook", presence: def.presence || false, core: Boolean(def.core),
          reach, outward: (e && e.outward) || null, target: (e && e.target) || null, projectArg: (e && e.projectArg) || null, cwdArg: (e && e.cwdArg) || null, declaredReach: objectForm.has(name) });
      },
    };
  }

  /**
   * Did the person's own words ask for this tool (reach "asked")? Asks vault.said.match, which
   * matches the person's turn in this thread or its lineage, or a standing permission, and uses a
   * plain ask up. Fails closed: no vault, a locked vault, an error or no thread answers no.
   * A tool with a `target` (an internal tool of its own module) binds the yes to what the call acts on: the target
   * answers { to: [string] } for this call's input, and that answer is the whole `to` of the match (each entry a
   * composite key of the tool and the thing it acts on). An error or an empty answer is no.
   * @param {string} tool @param {{ thread?: string, agent?: string }} meta @param {any} [def] @param {any} [input]
   */
  async saidMatch(tool, meta, def, input) {
    if (!this.tools.has("vault.said.match")) return false;
    try {
      /** @type {string[]} */ let to = [tool];
      if (def && def.target) {
        // The target is a module's own code answering for a call that may not be the person's: late is no.
        const t = await within(this.call(def.target, { tool, input }, "module:vyred", { door: true, ...(/** @type {any} */ (meta).granted !== undefined ? { granted: /** @type {any} */ (meta).granted } : {}) }), TARGET_MS);
        if (!t) return false;
        const extra = t && t.data && Array.isArray(t.data.to) ? t.data.to.filter((/** @type {any} */ x) => typeof x === "string" && x) : [];
        if (!extra.length) return false;
        to = extra;
      }
      const thread = typeof meta.thread === "string" ? meta.thread : undefined;
      let lineage;
      if (thread && this.tools.has("threads.lineage")) {
        const l = await within(this.call("threads.lineage", { thread }, "module:vyred", { door: true }), TARGET_MS);
        if (!l) return false;
        if (l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage;
      }
      const r = await this.call("vault.said.match", { kind: "act_out", via: tool.split(".")[0], to, consume: true, ...(thread ? { thread } : {}), ...(lineage ? { lineage } : {}), ...(meta.agent ? { agent: meta.agent } : {}) }, "module:vyred", { door: true });
      return Boolean(r.data && r.data.matched === true);
    } catch { return false; }
  }

  /**
   * Run a tool. Every call goes through the rules before it runs, whoever made it: Claude through
   * MCP, a surface through HTTP, or the CLI. That is the point of having one path.
   */
  /**
   * @param {string} tool @param {any} [input] @param {string} [caller]
   * @param {{ thread?: string, agent?: string, peer?: any, proof?: any, call?: string }} [meta] what vyred verified about the
   *   caller: the live thread (session id) it is calling from, the agent it is, and the tailnet
   *   node a network listener established. A tool gets these beside the caller; a claim in the
   *   input is not verified and must not be treated as if it were. `proof` is the presence proof
   *   the request carried, checked here and not passed on. `call` is the chat's id for this
   *   tool call (X-Vyre-Call-Id, only on a session's own paths): an unverified claim a tool may
   *   keep to link what it shows (a Glass step) to the chat's tool row, and never use for any
   *   decision. `granted` (with `agentKind`) is the verified agent's stored project grant, "*" or
   *   slugs, read by vyred from the agents module; a tool that scopes by project trusts it, never an
   *   input filter. Any other key a caller of this method adds reaches the tool the same way.
   */
  async call(tool, input = {}, caller = "unknown", { proof = null, keep = false, terminal = null, idempotencyKey = undefined, door = false, ...meta } = {}) {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    // Default-deny for an added module (ADR 0047, reviews/platform.md H4): it reaches only a tool
    // whose reach is declared, and never one declared for Vyre's own modules. `door` is the
    // loader's own ctx doors (vault.fetch, memory.teach, remote), which check their own declarations.
    if (!door && String(caller).startsWith("module:")) {
      const from = this.modules.get(String(caller).slice(7));
      // A module's own tools are its own business, in either form.
      if (from && from.dir && def.module !== from.manifest?.name && !this.isFirstParty(from.dir) && (!def.declaredReach || def.reach === "modules")) {
        return { error: { code: "not_declared", message: `${tool} is not open to added modules` } };
      }
    }
    // Fail closed until the Gate's routing and the P17 match are wired into the registry
    // (reviews/platform.md CR-H1): an outward tool runs only from the person's own surface or
    // device, and an asked tool never runs for a model, the harness or a module, since nothing
    // here can yet tell that the person's own words asked for it.
    if (def.outward && !isPerson(caller)) {
      return { error: { code: "held_unavailable", message: `${tool} acts as you outside. A call from anyone but you is held at the Gate, and that routing lands with the Gate wiring; until then it runs only from your own surface.` } };
    }
    if (def.internal && !String(caller).startsWith("module:")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (Boolean(def.hook) !== (caller === "hook")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (!callerAllowed(def.callers, caller)) return { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
    // A guest from another tailnet is never a person proving they are here, whatever proof it
    // carries: presence is the owner's (ADR 0014 part 8), and so is the keyboard of an agent's
    // computer, which needs no proof (PERSON_ONLY). The router already hides these tools.
    if (String(caller).startsWith("tailnet-guest:") && (PERSON_ONLY.has(tool) || (this.deps.presence ? this.deps.presence.required(tool, def, input) : def.presence))) {
      return { error: { code: "denied", message: `${tool} is the owner's; a guest never approves or proves presence` } };
    }
    // Over the tailnet a node signed in as the owner, and over the relay a paired device
    // (`device:<id>`), is the owner's device, and so is any script on it (ADR 0032). The person's
    // own actions there need the person's session too (core/presence/person.js),
    // which only vyred's router sets, from a cookie or a signed bearer token. Signing in is the one
    // way to get it, and the first passkey is enrolled with onboarding's code.
    if (ownerDevice(caller) && !meta.person && !PERSON_FREE.has(tool) && !machineSelf(tool, input)
      && (PERSON_ONLY.has(tool) || (this.deps.presence ? this.deps.presence.required(tool, def, input) : Boolean(def.presence)))) {
      return { error: { code: "person_session_required", message: `${tool} is the person's own action: sign in on this device with your passkey first` } };
    }
    const problems = checkInput(def.input, input);
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    // A tool that takes a project declares projectArg, and one that takes a folder declares cwdArg. An agent's call for a
    // project it is not granted (or a folder in one) is refused here, once, for every module alike: the one door is
    // projects.reach (owner's revokes and the assistant's rule included). not_found, so a refusal never says whether the
    // project exists. What was checked is what runs: a named project is rewritten to the canonical slug that was authorized.
    // The tool gets meta.reach for what it lists; with no answer on the agent's grant it gets nothing (fail closed).
    if ((def.projectArg || def.cwdArg) && agentClaim(caller) !== null) {
      const fields = (/** @type {any} */ spec) => (spec ? (Array.isArray(spec) ? spec : [spec]) : []);
      const valuesOf = (/** @type {string} */ arg) => {
        const v = input && typeof input === "object" ? input[arg] : undefined;
        return v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v];
      };
      const refuse = { error: { code: "not_found", message: "no such project" } };
      const named = fields(def.projectArg).flatMap(valuesOf);
      const folders = fields(def.cwdArg).flatMap(valuesOf);
      const r = await within(this.call("projects.reach", { caller: String(caller), kind: "content" }, "module:vyred", { door: true }), TARGET_MS);
      const reach = r && r.data && typeof r.data === "object" ? r.data : null;
      if (!reach) {
        if (named.length || folders.length) return refuse;
        meta = { ...meta, reach: { all: false, projects: [] } };
      } else {
        const granted = reach.all ? null : (Array.isArray(reach.projects) ? reach.projects : []).filter((/** @type {any} */ p) => p && typeof p.slug === "string");
        if (granted) {
          // A name or a slug, exactly; a slug first. Anything else (an object, a number) is no.
          const canon = (/** @type {any} */ v) => typeof v !== "string" ? null : (granted.find((/** @type {any} */ p) => p.slug === v) || granted.find((/** @type {any} */ p) => p.name === v) || {}).slug || null;
          if (named.some(v => canon(v) === null)) return refuse;
          let rewritten = input;
          for (const arg of fields(def.projectArg)) {
            const v = input && typeof input === "object" ? input[arg] : undefined;
            if (v === undefined || v === null || v === "") continue;
            rewritten = { ...rewritten, [arg]: Array.isArray(v) ? v.map(canon) : canon(v) };
          }
          input = rewritten;
          // A folder belongs to the project that owns it; one in no project is refused for an agent with an explicit list.
          if (folders.length) {
            let scoped = null;
            /** @type {Map<string, string>} the folder as given -> the real folder projects.of judged */
            const canonical = new Map();
            for (const cwd of folders) {
              const o = typeof cwd === "string" ? await within(this.call("projects.of", { cwd }, "module:vyred", { door: true }), TARGET_MS) : null;
              const slug = o && o.data && typeof o.data.slug === "string" ? o.data.slug : null;
              if (slug) {
                if (!granted.some((/** @type {any} */ p) => p.slug === slug)) return refuse;
                // What was judged is what runs: the tool gets the real folder (no `..`, no symlink), not the string it was sent.
                if (typeof o.data.folder === "string" && o.data.folder) canonical.set(cwd, o.data.folder);
                continue;
              }
              if (scoped === null) {
                const sc = await within(this.call("agents.scope", { name: String(agentClaim(caller)) }, "module:vyred", { door: true }), TARGET_MS);
                const who = sc && sc.data ? sc.data : null;
                scoped = !who || (who.kind !== "assistant" && who.projects !== "*");
              }
              if (scoped) return refuse;
            }
            if (canonical.size) {
              const swap = (/** @type {any} */ v) => (typeof v === "string" && canonical.has(v) ? canonical.get(v) : v);
              for (const arg of fields(def.cwdArg)) {
                const v = input && typeof input === "object" ? input[arg] : undefined;
                if (v === undefined || v === null) continue;
                input = { ...input, [arg]: Array.isArray(v) ? v.map(swap) : swap(v) };
              }
            }
          }
        }
        meta = { ...meta, reach: reach.all ? { all: true } : { all: false, projects: (Array.isArray(reach.projects) ? reach.projects : []).map((/** @type {any} */ p) => p && p.slug).filter(Boolean) } };
      }
    }
    if (this.deps.rules) {
      const verdict = await this.deps.rules({ tool, input, caller });
      if (!verdict.allow) return { error: { code: "denied", message: verdict.reason || "denied by rules" } };
    }
    // A human-only tool needs a proof that a person is there, whatever the caller claims
    // (docs/adr/0004-presence.md). Only modules are exempt: only the loader makes those callers.
    const presence = this.deps.presence;
    // A tool vyre-core answers on this Mac (def.core, ADR 0040 phase 2): core checks the proof
    // itself, over the exact input, so vyred passes it through untouched rather than checking (and
    // spending) it first. Only when core is linked; everywhere else the floor below applies.
    if (def.core && coreHolder.link) {
      meta = { ...meta, coreProof: proof ? formatProof(proof) : undefined };
    } else if (presence && callerKind(caller) !== "module" && presence.required(tool, def, input)) {
      const v = await presence.verify({ tool, input, caller, proof, def, peer: meta.peer || null, terminal: typeof terminal === "string" || (terminal && typeof terminal === "object") ? terminal : null });
      if (!v.ok) return { error: { code: v.code === "no_dialog" ? "no_dialog" : "presence_required", message: v.message, methods: v.methods } };
      // The tool learns how the person proved it (and with which enrolled key), never the proof.
      meta = { ...meta, presence: { method: v.method, keyId: v.keyId ?? null, ...(v.where ? { where: v.where } : {}) } };
    }
    // A call that carries an Idempotency-Key runs once per key; a retry gets the first answer.
    // The key reaches the tool too, so a tool that hands work on can carry it (threads.send uses
    // it as the Agent SDK message uuid, ADR 0030), and a retry after a restart is still one turn.
    // A tool that ran counts as a use of its module, whether it succeeded or threw; a refusal
    // above never ran, and neither does a replayed answer. One module calling another is plumbing,
    // not use, and nor is a webhook.
    const counted = !["module", "hook"].includes(callerKind(caller));
    // meta.firstParty: the caller is one of Vyre's own modules, by the loader's one rule
    // (firstParty above). Set here, over anything a caller passed, so no module can claim it.
    const rec = String(caller).startsWith("module:") ? this.modules.get(String(caller).slice(7)) : null;
    const fp = Boolean(rec && rec.dir && this.isFirstParty(rec.dir));
    // An asked tool runs for a model, the harness or a module only when the person's own words asked for it. This is the
    // LAST gate before the tool runs, and inside the once-per-key run: the match uses the ask up (consume), so a call
    // refused above (bad input, a rule, a proof) and a retry that only replays the stored answer must never spend it.
    const askedGate = def.reach === "asked" && (["mcp", "harness", "module"].includes(callerKind(caller)) || agentClaim(caller) !== null);
    const run = async () => {
      if (askedGate && !(await this.saidMatch(tool, meta, def, input))) {
        return { error: { code: "not_asked", message: `${tool} runs for an agent only when your own words asked for it; tell the person what you would do` } };
      }
      try { return await this.run(def, input, { ...meta, caller, firstParty: fp, ...(idempotencyKey ? { idempotencyKey } : {}) }); }
      finally { if (counted) this.countUse(def.module); }
    };
    const result = idempotencyKey && this.idempotency ? await this.idempotency.once({ caller, tool, key: idempotencyKey, input }, run) : await run();
    // keep: the person asked that this proof also open a presence session on their device, so
    // the next sessionable call (another send) needs no second Touch ID or passkey. Only a strong
    // proof opens one (presence.openSession refuses the rest); the secret goes back once, and a
    // replayed answer never carries one (it is outside what the idempotency record keeps).
    if (keep && !result.error && presence && meta.presence && meta.presence.method !== "session") {
      try { return { ...result, session: presence.openSession({ method: meta.presence.method, keyId: meta.presence.keyId, peer: meta.peer || null }) }; }
      catch { /* a code or tty proof: the call still succeeded, with no session */ }
    }
    return result;
  }

  /** @param {any} def @param {any} input @param {any} meta */
  async run(def, input, meta) {
    // The caller is passed on, so a tool like vault.release can check which module is asking.
    try { return { data: await def.run(input, meta) }; }
    catch (e) {
      // A tool may throw an error carrying a code the caller can act on (a presence refusal, a
      // conflict, a missing grant). Pass a short lowercase code through; anything else is "failed".
      const err = /** @type {any} */ (e);
      const code = typeof err?.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(err.code) ? err.code : "failed";
      return { error: { code, message: err?.message || String(e), ...(err?.detail && typeof err.detail === "object" ? { detail: err.detail } : {}) } };
    }
  }

  /**
   * May the capsule module call `tool` as `as`? Only a tool a running module's shows.capsule declares
   * (a view's list, detail, action or form submit, or the older results: and action: keys). As the
   * person's surface: a first party module's. As module:<name>: that module's own, and only its own
   * tools or the ones it listed in needs.tools.
   * @param {string} as @param {string} tool
   */
  capsuleMayCall(as, tool) {
    const named = as.startsWith("module:") ? as.slice(7) : null;
    // The hub's own tools: the Capsule lists a server's tools and runs one as the person (a write is held at the Gate).
    if (!named && ["mcp.servers", "mcp.tools", "mcp.call"].includes(tool)) return true;
    for (const [name, r] of this.modules.entries()) {
      if (r.state !== "running" || !r.manifest) continue;
      const cap = r.manifest.shows && r.manifest.shows.capsule;
      if (!cap || typeof cap !== "object" || Array.isArray(cap)) continue;
      const fp = this.isFirstParty(r.dir);
      if (named ? named !== name : !fp) continue;
      const declared = new Set();
      for (const [key, v] of Object.entries(cap)) {
        if (key.startsWith("results:")) declared.add(key.slice(8));
        else if (key.startsWith("action:")) declared.add(key.slice(7).split("#")[0]);
        else if (key.startsWith("view:") && v && typeof v === "object") {
          const e = /** @type {any} */ (v), l = e.list || {};
          if (l.tool) declared.add(l.tool);
          if (l.detail && l.detail.tool) declared.add(l.detail.tool);
          for (const a of Array.isArray(l.actions) ? l.actions : []) if (a && a.tool) declared.add(a.tool);
          for (const f of Object.values(e.forms || {})) if (f && /** @type {any} */ (f).submit && /** @type {any} */ (f).submit.tool) declared.add(/** @type {any} */ (f).submit.tool);
        }
      }
      if (!declared.has(tool)) continue;
      if (!named) return true;
      const needs = r.manifest.needs && Array.isArray(r.manifest.needs.tools) ? r.manifest.needs.tools : [];
      if (tool.startsWith(name + ".") || needs.includes(tool)) return true;
    }
    return false;
  }

  /** The search (or resolve) tools running first-party modules offer the # picker: mentions calls search as the asking person and resolve as sessions or the assistant, nothing else. @param {"search" | "resolve"} [which] */
  mentionTools(which = "search") {
    const out = new Set();
    for (const r of this.modules.values()) {
      if (r.state !== "running" || !r.manifest || !Array.isArray(r.manifest.mentions) || !this.isFirstParty(r.dir)) continue;
      for (const e of r.manifest.mentions) if (e && typeof e[which] === "string") out.add(e[which]);
    }
    return out;
  }

  /** The getter and setter tools first-party modules name in their settings' tool stores. */
  settingTools() {
    const out = new Set();
    for (const r of this.modules.values()) {
      if (r.state !== "running" || !r.manifest || !Array.isArray(r.manifest.settings) || !this.isFirstParty(r.dir)) continue;
      for (const d of r.manifest.settings) {
        const t = d && d.store && d.store.tool;
        if (t && t.get && t.get.tool) out.add(String(t.get.tool));
        if (t && t.set && t.set.tool) out.add(String(t.set.tool));
      }
    }
    return out;
  }

  status() {
    // `shows` says which surfaces a module offers itself to (SPEC 5.1): the Capsule reads
    // shows.capsule here for the results and actions it lists. What else a manifest declares for
    // the surfaces rides beside it as given (ADR 0033): its CLI verbs, the tools that answer for
    // its connections and for suggest, the notice kinds it raises and the events it emits.
    return [...this.modules.entries()].map(([name, r]) => {
      const m = r.manifest || {}, u = this.use.get(name);
      return { name, version: r.manifest && r.manifest.version, state: r.state, error: r.error,
        ...(m.shows ? { shows: m.shows } : {}),
        ...(m.does && m.does.commands ? { commands: m.does.commands } : {}),
        ...(m.does && m.does.connections ? { connections: m.does.connections } : {}),
        ...(m.does && m.does.suggest ? { suggest: m.does.suggest } : {}),
        ...(Array.isArray(m.mentions) ? { mentions: m.mentions } : {}),
        firstParty: this.isFirstParty(r.dir),
        ...(m.needs && Array.isArray(m.needs.tools) ? { needsTools: m.needs.tools.filter((/** @type {any} */ t) => typeof t === "string") } : {}),
        ...(m.needs && Array.isArray(m.needs.slots) ? { needsSlots: m.needs.slots.filter((/** @type {any} */ t) => typeof t === "string") } : {}),
        ...(m.shows && m.shows.notices ? { notices: m.shows.notices } : {}),
        ...(m.watches && m.watches.emits ? { emits: m.watches.emits } : {}),
        ...(m.needs && Array.isArray(m.needs.credentials) ? { credentials: m.needs.credentials } : {}),
        use: { calls: u ? u.calls : 0, lastUsed: u && u.lastUsed ? u.lastUsed : null } };
    });
  }

  /** Tools the given caller may use. Without a caller, every tool that is neither internal nor a hook. */
  listTools(caller) {
    const needs = (name, d) => (this.deps.presence ? this.deps.presence.required(name, d) : Boolean(d.presence));
    return [...this.tools.entries()].filter(([, d]) => !d.internal && !d.hook && (!caller || callerAllowed(d.callers, caller)))
      .map(([name, d]) => ({ name, module: d.module, description: d.description, input: d.input, ...(needs(name, d) ? { presence: true } : {}),
        // Module API 1: what an object entry declared, for the capability manifest.
        ...(d.declaredReach ? { reach: d.reach } : {}), ...(d.outward ? { outward: d.outward } : {}) }));
  }

  /** Start a presence proof that needs a challenge (tty, passkey) for one call of a tool. */
  async presenceChallenge(tool, input = {}, method, extra = {}) {
    const def = this.tools.get(tool);
    if (!def || def.internal || def.hook) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (!this.deps.presence) return { error: { code: "bad_input", message: "presence is not checked on this registry" } };
    const r = await this.deps.presence.challenge({ ...extra, tool, input, method, def });
    return r.error ? { error: r.error } : { data: r };
  }

  async stop() {
    for (const [name, r] of [...this.modules.entries()].reverse()) {
      if (r.state === "running" && r.handle && typeof r.handle.stop === "function") {
        try {
          // A module whose own stop() never settles (an open handle, an awaited promise nothing
          // ever resolves) used to hang every caller of this method forever, with nothing to say
          // why: a real vyred shutdown, and any test that starts one in-process (core/settings/
          // settings.test.js, among others) and stops it in t.after. Race it against the same
          // bound the daemon already gives its own drain (DRAIN_MS), and say so loudly rather
          // than hang silently at 0% CPU.
          const timedOut = await within(r.handle.stop().then(() => false), MODULE_STOP_MS, true);
          if (timedOut) this.deps.log(`warn: module ${name} did not stop within ${MODULE_STOP_MS}ms; moving on`);
        } catch {}
      }
    }
    // Last, so a call a module made while stopping is counted too. vyred closes the database after.
    this.flushUse();
  }
}
