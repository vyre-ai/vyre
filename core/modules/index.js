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
import { pathToFileURL } from "node:url";
import { migrate } from "../store/index.js";

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
const VERBS = ["does", "watches", "shows", "needs", "teaches"];

/**
 * Check a manifest. Returns a list of problems; empty means valid.
 * @param {any} m
 */
export function validate(m) {
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
  return out;
}

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
      try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); problems = validate(manifest); }
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
  return c.startsWith("module:") ? "module" : c.replace(/[\s:]agent:.*$/s, "");
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
          const declared = (m.needs && m.needs.vault) || [];
          if (!declared.includes(name) && !declared.some(d => d.startsWith("per-"))) throw new Error(`${m.name} asked the vault for ${name}, which its manifest does not declare under needs.vault`);
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
      call: (tool, input) => this.call(tool, input, `module:${m.name}`),
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
   * @param {{ thread?: string, agent?: string, peer?: any, proof?: any }} [meta] what vyred verified about the
   *   caller: the live thread (session id) it is calling from, the agent it is, and the tailnet
   *   node a network listener established. A tool gets these beside the caller; a claim in the
   *   input is not verified and must not be treated as if it were. `proof` is the presence proof
   *   the request carried, checked here and not passed on.
   */
  async call(tool, input = {}, caller = "unknown", { proof = null, ...meta } = {}) {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (def.internal && !String(caller).startsWith("module:")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (Boolean(def.hook) !== (caller === "hook")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (def.callers && !def.callers.includes(callerKind(caller))) return { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
    // A guest from another tailnet is never a person proving they are here, whatever proof it
    // carries: presence is the owner's (ADR 0014 part 8). The router already hides these tools.
    if (String(caller).startsWith("tailnet-guest:") && (this.deps.presence ? this.deps.presence.required(tool, def) : def.presence)) {
      return { error: { code: "denied", message: `${tool} is the owner's; a guest never approves or proves presence` } };
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
    if (presence && callerKind(caller) !== "module" && presence.required(tool, def)) {
      const v = await presence.verify({ tool, input, caller, proof, def, peer: meta.peer || null });
      if (!v.ok) return { error: { code: v.code === "no_dialog" ? "no_dialog" : "presence_required", message: v.message, methods: v.methods } };
      // The tool learns how the person proved it (and with which enrolled key), never the proof.
      meta = { ...meta, presence: { method: v.method, keyId: v.keyId ?? null } };
    }
    // The caller is passed on, so a tool like vault.release can check which module is asking.
    try { return { data: await def.run(input, { ...meta, caller }) }; }
    catch (e) {
      // A tool may throw an error carrying a code the caller can act on (a presence refusal, a
      // conflict, a missing grant). Pass a short lowercase code through; anything else is "failed".
      const err = /** @type {any} */ (e);
      const code = typeof err?.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(err.code) ? err.code : "failed";
      return { error: { code, message: err?.message || String(e), ...(err?.detail && typeof err.detail === "object" ? { detail: err.detail } : {}) } };
    }
  }

  status() {
    // `shows` says which surfaces a module offers itself to (SPEC 5.1): the Capsule reads
    // shows.capsule here for the results and actions it lists.
    return [...this.modules.entries()].map(([name, r]) => ({ name, version: r.manifest && r.manifest.version, state: r.state, error: r.error,
      ...(r.manifest && r.manifest.shows ? { shows: r.manifest.shows } : {}) }));
  }

  /** Tools the given caller may use. Without a caller, every tool that is neither internal nor a hook. */
  listTools(caller) {
    const needs = (name, d) => (this.deps.presence ? this.deps.presence.required(name, d) : Boolean(d.presence));
    return [...this.tools.entries()].filter(([, d]) => !d.internal && !d.hook && (!caller || !d.callers || d.callers.includes(callerKind(caller))))
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
  }
}
