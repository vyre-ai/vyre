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
import { PERSON_ONLY } from "../presence/index.js";
import { validateDecls } from "../config/settings.js";
import * as config from "../config/index.js";

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
const CALL_AS = { link: ["link:box"], settings: ["cli", "local", "deck", "capsule"] };
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
const VERBS = ["does", "watches", "shows", "needs", "teaches"];
/** Use counts reach vyre.db at most this often; nothing is written while nothing was used. */
const USE_FLUSH = 60_000;

/**
 * Check a manifest. Returns a list of problems; empty means valid. `firstParty` is true for a
 * module shipped with Vyre; a module from anywhere else is held to more (its settings' stores).
 * @param {any} m @param {{ firstParty?: boolean }} [opts]
 */
export function validate(m, { firstParty = false } = {}) {
  const out = [];
  if (!m || typeof m !== "object") return ["module.json is not an object"];
  if (!NAME.test(String(m.name || ""))) out.push(`name "${m.name}" must be lowercase letters, digits and dashes`);
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ""))) out.push(`version "${m.version}" must be semver`);
  if (m.roles && (!Array.isArray(m.roles) || m.roles.some(r => !["box", "local"].includes(r)))) out.push("roles must be a list of box and local");
  if (m.requires && !Array.isArray(m.requires)) out.push("requires must be a list");
  for (const v of VERBS) if (m[v] !== undefined && (typeof m[v] !== "object" || Array.isArray(m[v]))) out.push(`${v} must be an object`);
  for (const t of (m.does && m.does.tools) || []) {
    if (!TOOL.test(t)) out.push(`tool "${t}" must look like module.verb`);
    else if (!t.startsWith(m.name + ".")) out.push(`tool "${t}" must start with "${m.name}."`);
  }
  for (const e of (m.watches && m.watches.emits) || []) if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(e)) out.push(`event "${e}" must look like noun.past-verb`);
  out.push(...validateDecls(String(m.name), m.settings, { firstParty, tools: (m.does && m.does.tools) || [] }));
  // Session providers (ADR 0030): drivers the Switchboard can run a session on, besides Claude.
  const providers = m.does && m.does.providers;
  if (providers !== undefined && (!Array.isArray(providers) || providers.some(p => !NAME.test(String(p))))) out.push("does.providers must be a list of lowercase names");
  out.push(...checkCredentials(m.needs && m.needs.credentials));
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

/** Every folder under the given roots that holds a module.json. */
export function discover(roots) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, "module.json");
      if (!fs.existsSync(file)) continue;
      let manifest = null, problems = [];
      try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); problems = validate(manifest, { firstParty: firstParty(dir) }); }
      catch (err) { problems = ["module.json unreadable: " + /** @type {Error} */ (err).message]; }
      found.push({ dir, manifest, problems });
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
    for (const dep of m.manifest.requires || []) {
      const d = byName.get(dep);
      if (!d) { problems.set(n, `requires "${dep}", which is not available`); stack.delete(n); return false; }
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
export const callerKind = caller => {
  const c = String(caller);
  // "mcp:agent:<name>" and "mcp:thread:<id>" (a Vyre-owned session, ADR 0030) are both "mcp".
  return c.startsWith("module:") ? "module" : c.replace(/[\s:](agent|thread):.*$/s, "");
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
   *           presence?: import("../presence/index.js").Presence }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, { module: string, description: string, input: any, run: Function }>} */
    this.tools = new Map();
    /** @type {Map<string, { manifest: any, dir: string, state: string, error?: string, handle?: any }>} */
    this.modules = new Map();
    /** @type {Map<string, { module: string, handler: Function }>} WebSocket paths, keyed "<module>/<name>". */
    this.upgrades = new Map();
    /** @type {Map<string, (req: any, res: any, at: { caller: string, url: URL }) => any>} */
    this.routes = new Map();
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

  /** Start every discovered module that is enabled for this machine's role. */
  async start(found, { role, enable = [], disable = [] }) {
    for (const f of found) {
      const name = f.manifest && f.manifest.name;
      if (f.problems.length) { this.modules.set(name || f.dir, { manifest: f.manifest, dir: f.dir, state: "invalid", error: f.problems.join("; ") }); continue; }
      // Two modules with one name: the first found wins (Vyre's own folders come before the
      // user's), and the other is reported, never silently dropped. A user's module named like a
      // core one once vanished without a word, and so did every tool it offered.
      if (this.modules.has(name)) {
        this.modules.set(`${name}@${f.dir}`, { manifest: f.manifest, dir: f.dir, state: "invalid",
          error: `a module named ${name} is already loaded from ${this.modules.get(name).dir}; this one is ignored` });
        continue;
      }
      const roles = f.manifest.roles || ["box", "local"];
      const on = !disable.includes(name) && (roles.includes(role) || enable.includes(name));
      this.modules.set(name, { manifest: f.manifest, dir: f.dir, state: on ? "pending" : "off" });
    }
    const candidates = found.filter(f => { const r = this.modules.get(f.manifest && f.manifest.name); return r?.state === "pending" && r.dir === f.dir; });
    const { ordered, problems } = order(candidates);
    for (const [n, why] of problems) Object.assign(this.modules.get(n), { state: "failed", error: why });
    for (const f of ordered) await this.startOne(f);
    return this.status();
  }

  async startOne(f) {
    const m = f.manifest, rec = this.modules.get(m.name);
    const failedDep = (m.requires || []).find(d => this.modules.get(d)?.state !== "running");
    if (failedDep) { Object.assign(rec, { state: "failed", error: `requires "${failedDep}", which is not running` }); return; }
    try {
      const entry = path.join(f.dir, m.main || "index.js");
      const mod = (await import(pathToFileURL(entry).href)).default;
      if (!mod || typeof mod.start !== "function") throw new Error("entry file must export default { start(ctx) }");
      rec.handle = await mod.start(this.context(m));
      rec.state = "running";
      this.deps.log(`module ${m.name} ${m.version} running`);
    } catch (e) {
      Object.assign(rec, { state: "failed", error: /** @type {Error} */ (e).message });
      for (const [t, def] of this.tools) if (def.module === m.name) this.tools.delete(t);
      for (const [k, u] of this.upgrades) if (u.module === m.name) this.upgrades.delete(k);
      for (const [k] of this.routes) if (k.startsWith(`/v1/${m.name}/`)) this.routes.delete(k);
      this.deps.log(`module ${m.name} failed to start: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** What a module gets. It sees only what its manifest declared. */
  context(m) {
    const { db, events, config, log, paths } = this.deps;
    const declared = new Set((m.does && m.does.tools) || []);
    return {
      name: m.name, config, paths,
      // Every running module's declared settings (module.json "settings"), for the settings
      // module to serve. Manifests are public; a module switched off takes its settings with it.
      declaredSettings: () => [...this.modules.entries()].filter(([, r]) => r.state === "running" && r.manifest && Array.isArray(r.manifest.settings))
        // module and firstParty come from the loader, after the declaration, so a manifest can't claim them.
        .flatMap(([name, r]) => r.manifest.settings.map(d => ({ ...d, module: name, firstParty: firstParty(r.dir) }))),
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
      log: (msg, extra) => log(`[${m.name}] ${msg}`, extra),
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
      vault: {
        fetch: async (name, { field, watcher } = {}) => {
          const declared = [...((m.needs && m.needs.vault) || []), ...credentialItems(m)];
          if (!declared.includes(name) && !declared.some(d => d.startsWith("per-")) && !multipleItem(m, name)) throw new Error(`${m.name} asked the vault for ${name}, which its manifest does not declare under needs.vault or needs.credentials`);
          const r = await this.call("vault.release", { name, ...(field ? { field } : {}), ...(watcher ? { watcher } : {}) }, `module:${m.name}`);
          if (r.error) throw new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message);
          return r.data && r.data.value;
        },
      },
      // Facts for the curator's queue, of the kinds declared under teaches.memory. Memory decides
      // what to keep; a module never writes Memory's tables. Without Memory running, a no-op.
      memory: {
        teach: async (kind, fact) => {
          const declared = (m.teaches && m.teaches.memory) || [];
          if (!declared.includes(kind)) throw new Error(`${m.name} taught ${kind}, which its manifest does not declare under teaches.memory`);
          const r = await this.call("memory.teach", { kind, fact, from: m.name }, `module:${m.name}`);
          return !r.error;
        },
      },
      // Another module's tool, through the same path as every caller: input checked, rules run.
      // This is the only way one module uses another; never import its files.
      // `as` calls under another caller label: only a core module, and only a label CALL_AS
      // gives it. A manifest cannot grant this, so a module installed into a home never can.
      call: (tool, input, opts) => {
        const as = opts && opts.as;
        if (!as) return this.call(tool, input, `module:${m.name}`);
        const rec = this.modules.get(m.name);
        const core = Boolean(rec && path.resolve(rec.dir).startsWith(CORE_DIR + path.sep));
        if (!core || !(CALL_AS[m.name] || []).includes(String(as))) throw new Error(`${m.name} may not call ${tool} as ${as}`);
        // settings relays a person only to the tools first-party modules declared as their own
        // settings' getters and setters, never to any other tool (e2e review, HIGH 2).
        if (m.name === "settings" && !this.settingTools().has(tool)) throw new Error(`settings may not call ${tool} as ${as}: no first-party setting names it`);
        return this.call(tool, input, String(as));
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
      handler: policy => { if (!this.deps.handler) throw new Error("this vyred has no router to hand out"); return this.deps.handler(policy); },
      // The same for WebSocket upgrades (/v1/streams/...): (req, socket, head, caller). Without it
      // a module's listener cannot carry a stream, and Glass over the tailnet never connected.
      upgrader: policy => { if (!this.deps.upgrader) throw new Error("this vyred has no stream router to hand out"); return this.deps.upgrader(policy); },
      // A tool on the user's box, from a module on the Mac: the link module carries it over the
      // tailnet. Resolves like call(), and to { error: { code: "box_unreachable" } } when the
      // box cannot be reached, so a caller can fall back to what this machine has.
      remote: async (tool, input = {}) => {
        const r = await this.call("link.remote", { tool, input }, `module:${m.name}`);
        return r.error && r.error.code === "no_such_tool" ? { error: { code: "no_link", message: "this machine is not linked to a box" } } : r.data && r.data.result ? r.data.result : r;
      },
      // A raw HTTP route on vyred's socket at /v1/<module>/<name>, for what a tool cannot carry:
      // a stream. The route sees the caller the router established; it never reads one itself.
      route: (name, fn) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`route ${name} must be lowercase letters, digits and dashes`);
        const at = `/v1/${m.name}/${name}`;
        if (this.routes.has(at)) throw new Error(`route ${at} is already registered`);
        this.routes.set(at, fn);
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
        this.tools.set(name, { module: m.name, description: def.description || "", input: def.input || { type: "object" }, run: def.run, internal: Boolean(def.internal),
          callers: Array.isArray(def.callers) ? def.callers : null, hook: Boolean(def.hook), presence: def.presence || false });
      },
    };
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
   *   decision. Any other key a caller of this method adds reaches the tool the same way.
   */
  async call(tool, input = {}, caller = "unknown", { proof = null, keep = false, terminal = null, idempotencyKey = undefined, ...meta } = {}) {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
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
    if (ownerDevice(caller) && !meta.person && !PERSON_FREE.has(tool)
      && (PERSON_ONLY.has(tool) || (this.deps.presence ? this.deps.presence.required(tool, def, input) : Boolean(def.presence)))) {
      return { error: { code: "person_session_required", message: `${tool} is the person's own action: sign in on this device with your passkey first` } };
    }
    const problems = checkInput(def.input, input);
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    if (this.deps.rules) {
      const verdict = await this.deps.rules({ tool, input, caller });
      if (!verdict.allow) return { error: { code: "denied", message: verdict.reason || "denied by rules" } };
    }
    // A human-only tool needs a proof that a person is there, whatever the caller claims
    // (docs/adr/0004-presence.md). Only modules are exempt: only the loader makes those callers.
    const presence = this.deps.presence;
    if (presence && callerKind(caller) !== "module" && presence.required(tool, def, input)) {
      const v = await presence.verify({ tool, input, caller, proof, def, peer: meta.peer || null, terminal: typeof terminal === "string" || (terminal && typeof terminal === "object") ? terminal : null });
      if (!v.ok) return { error: { code: v.code === "no_dialog" ? "no_dialog" : "presence_required", message: v.message, methods: v.methods } };
      // The tool learns how the person proved it (and with which enrolled key), never the proof.
      meta = { ...meta, presence: { method: v.method, keyId: v.keyId ?? null, ...(v.where ? { where: v.where } : {}) } };
    }
    // A call that carries an Idempotency-Key runs once per key; a retry gets the first answer.
    // The key reaches the tool too, so a tool that hands work on can carry it (threads.send uses
    // it as the Agent SDK message uuid, ADR 0030), and a retry after a restart is still one turn.
    // meta.firstParty: the caller is one of Vyre's own modules, by the loader's one rule
    // (firstParty above). Set here, over anything a caller passed, so no module can claim it.
    const rec = String(caller).startsWith("module:") ? this.modules.get(String(caller).slice(7)) : null;
    const fp = Boolean(rec && rec.dir && firstParty(rec.dir));
    // A tool that ran counts as a use of its module, whether it succeeded or threw; a refusal
    // above never ran, and neither does a replayed answer. One module calling another is plumbing,
    // not use, and nor is a webhook.
    const counted = !["module", "hook"].includes(callerKind(caller));
    const run = async () => {
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

  /** The getter and setter tools first-party modules name in their settings' tool stores. */
  settingTools() {
    const out = new Set();
    for (const r of this.modules.values()) {
      if (r.state !== "running" || !r.manifest || !Array.isArray(r.manifest.settings) || !firstParty(r.dir)) continue;
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
      .map(([name, d]) => ({ name, module: d.module, description: d.description, input: d.input, ...(needs(name, d) ? { presence: true } : {}) }));
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
    for (const [, r] of [...this.modules.entries()].reverse()) {
      if (r.state === "running" && r.handle && typeof r.handle.stop === "function") {
        try { await r.handle.stop(); } catch {}
      }
    }
    // Last, so a call a module made while stopping is counted too. vyred closes the database after.
    this.flushUse();
  }
}
