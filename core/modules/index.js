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

/** "module:notes" is a module; every other caller is its own kind: "cli", "local", "mcp". */
export const callerKind = caller => (String(caller).startsWith("module:") ? "module" : String(caller));

export class Registry {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, events: any, config: any, log: (m: string, x?: any) => void,
   *           rules?: (call: { tool: string, input: any, caller: string }) => Promise<{ allow: boolean, reason?: string }> }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, { module: string, description: string, input: any, run: Function }>} */
    this.tools = new Map();
    /** @type {Map<string, { manifest: any, dir: string, state: string, error?: string, handle?: any }>} */
    this.modules = new Map();
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
      },
      // Vault items, one at a time, only those the manifest declares under needs.vault. The value
      // comes from the vault module's internal vault.release tool, which only modules can call,
      // and which sees which module asked. "per-watcher" and "per-agent" are the declarations of
      // the watcher runtime and the agents module: their item names are dynamic, one set per
      // watcher or agent, so they must check those names themselves. The vault's grant still
      // decides, per item and per module.
      // `field` picks one field of an item (a login's password, say); `watcher` is for the
      // watcher runtime, whose grants are per watcher.
      vault: {
        fetch: async (name, { field, watcher } = {}) => {
          const declared = (m.needs && m.needs.vault) || [];
          if (!declared.includes(name) && !declared.includes("per-watcher") && !declared.includes("per-agent")) throw new Error(`${m.name} asked the vault for ${name}, which its manifest does not declare under needs.vault`);
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
      tool: (name, def) => {
        if (!declared.has(name)) throw new Error(`${m.name} registered tool ${name}, which its manifest does not declare under does.tools`);
        if (this.tools.has(name)) throw new Error(`tool ${name} is already registered`);
        if (typeof def.run !== "function") throw new Error(`tool ${name} needs a run function`);
        // internal: only other modules may call it (never Claude, the CLI or a surface), and it is
        // left out of every listing. vault.release is the reason this exists.
        // callers: the kinds of caller that may use it ("cli", "local", "mcp", "module"); a
        // tool is refused to, and left out of the listing for, any other. Omitted means all.
        this.tools.set(name, { module: m.name, description: def.description || "", input: def.input || { type: "object" }, run: def.run, internal: Boolean(def.internal),
          callers: Array.isArray(def.callers) ? def.callers : null });
      },
    };
  }

  /**
   * Run a tool. Every call goes through the rules before it runs, whoever made it: Claude through
   * MCP, a surface through HTTP, or the CLI. That is the point of having one path.
   */
  async call(tool, input = {}, caller = "unknown") {
    const def = this.tools.get(tool);
    if (!def) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (def.internal && !String(caller).startsWith("module:")) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (def.callers && !def.callers.includes(callerKind(caller))) return { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
    const problems = checkInput(def.input, input);
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    if (this.deps.rules) {
      const verdict = await this.deps.rules({ tool, input, caller });
      if (!verdict.allow) return { error: { code: "denied", message: verdict.reason || "denied by rules" } };
    }
    // The caller is passed on, so a tool like vault.release can check which module is asking.
    try { return { data: await def.run(input, { caller }) }; }
    catch (e) { return { error: { code: "failed", message: /** @type {Error} */ (e).message } }; }
  }

  status() {
    return [...this.modules.entries()].map(([name, r]) => ({ name, version: r.manifest && r.manifest.version, state: r.state, error: r.error }));
  }

  /** Tools the given caller may use. Without a caller, every tool that is not internal. */
  listTools(caller) {
    return [...this.tools.entries()].filter(([, d]) => !d.internal && (!caller || !d.callers || d.callers.includes(callerKind(caller)))).map(([name, d]) => ({ name, module: d.module, description: d.description, input: d.input }));
  }

  async stop() {
    for (const [, r] of [...this.modules.entries()].reverse()) {
      if (r.state === "running" && r.handle && typeof r.handle.stop === "function") {
        try { await r.handle.stop(); } catch {}
      }
    }
  }
}
