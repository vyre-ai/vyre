// @ts-check
// A module's test harness (ADR 0047 section 7): one module over a temp home, with no daemon.
//
//   import { testModule } from "@vyre/module-sdk/testing";
//   const t = await testModule(new URL(".", import.meta.url).pathname);
//   const r = await t.call("bakery.flour", { kg: 25 }, { who: "agent" });   // { held: "hold-1" }
//   await t.stop();
//
// createTestContext() builds the ctx a module's start(ctx) gets, held to its manifest the way the
// loader and the module host hold it: only declared tools, events and settings, ctx.call only to
// needs.tools, the vault only for needs.credentials, fetch only to needs.network. Everything that
// would leave the module (another module's tools, the Gate, the vault, the network, a model, push,
// spend, undo) is a fake that records what it was asked and answers from opts.
//
// call() is the registry's routing (ADR 0047 section 2), for the person, an agent, another module
// or a webhook: reach decides who may call, and an outward tool runs only for the person's own tap,
// an asking agent (the Gate's P17 match) or an approved hold. Anything else is held and not run.
//
// Nothing here starts a timer, opens a socket or spawns a process. The store is node:sqlite in the
// temp home's data folder. stop() closes it and removes the temp home this harness made.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { checkSchema, toolEntries } from "./manifest.js";

/** Event families only their owner may emit (ADR 0047 section 2). */
const RESERVED = ["sync.", "gate.", "presence.", "vault."];
const RESERVED_TYPES = ["turn.said"];
/** Features ctx.api.has() answers true for in API 1. */
const FEATURES = ["log.levels", "settings", "vault.request", "connections", "fetch", "gate.request", "memory.write", "ask", "spend", "push", "undo", "modules.status"];
/** Hosts ctx.fetch never reaches, whatever needs.network says: private, loopback, link-local, CGNAT, tailnet, metadata. */
const PRIVATE = [/^localhost$/, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./, /^\[?::1\]?$/, /^\[?f[cd]/i, /^\[?fe80:/i, /\.ts\.net$/, /^metadata(\.google\.internal)?$/];

/** A refusal a module can see: an Error with a short lowercase code, as the registry passes them. */
const refuse = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** Whether a declared pattern ("*", "noun.*", "noun.verb") covers a type or a narrower pattern. */
const covers = (/** @type {string} */ declared, /** @type {string} */ asked) => declared === "*" || declared === asked
  || (declared.endsWith(".*") && asked !== "*" && asked.startsWith(declared.slice(0, -1)));

/** Whether a host matches a needs.network entry: a host, *.domain, optionally with a port. */
const hostAllowed = (/** @type {string[]} */ list, /** @type {URL} */ u) => list.some(h => {
  const [name, port] = h.split(":");
  if (port && String(u.port || (u.protocol === "https:" ? 443 : 80)) !== port) return false;
  return name.startsWith("*.") ? u.hostname.endsWith(name.slice(1)) : u.hostname === name;
});

/**
 * Who a test call comes from. The person on their own surface, an agent (asked: the person's own
 * words in their own turn asked for exactly this), another module, or the webhook route.
 * @typedef {{ who?: "person" | "agent" | "module" | "hook", asked?: boolean, agent?: string, module?: string,
 *   project?: string, thread?: string }} As
 */

/**
 * What the fakes answer. Every key is optional; each fake has a plain default.
 * @typedef {{
 *   home?: string, firstParty?: boolean,
 *   tools?: Record<string, (input: any, meta: any) => any>,
 *   vault?: ((id: string, req: any) => any) | Record<string, any>,
 *   fetch?: (url: string, init: any) => any,
 *   ask?: (prompt: string, opts: any) => any,
 *   connections?: (provider: string, tool: string, input: any) => any,
 *   push?: "sent" | "deferred",
 *   settings?: Record<string, unknown>,
 *   modules?: any[],
 * }} Options
 */

/**
 * The ctx for one module, and the registry around it, over a temp home.
 * @param {any} manifest the module's module.json
 * @param {Options} [opts]
 */
export function createTestContext(manifest, opts = {}) {
  const m = manifest;
  if (!m || typeof m.name !== "string") throw new Error("createTestContext needs a manifest with a name");
  const name = m.name, firstParty = Boolean(opts.firstParty);
  const made = !opts.home;
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), `vyre-module-${name}-`));
  const data = path.join(home, "data", name);
  fs.mkdirSync(data, { recursive: true });

  const entries = new Map(toolEntries(m).map(e => [e.name, e]));
  const emits = (m.watches && m.watches.emits) || [];
  const on = (m.watches && m.watches.on) || [];
  const needsTools = (m.needs && m.needs.tools) || [];
  const credentials = ((m.needs && m.needs.credentials) || []).map((/** @type {any} */ c) => c.id);
  const network = (m.needs && m.needs.network) || [];
  const connections = ((m.needs && m.needs.connections) || []).map((/** @type {any} */ c) => c.provider);
  const capUsd = m.needs && m.needs.spend && typeof m.needs.spend.dailyUsd === "number" ? m.needs.spend.dailyUsd : null;
  /** @type {Map<string, any>} */
  const declaredSettings = new Map((Array.isArray(m.settings) ? m.settings : []).map((/** @type {any} */ s) => [s.key, s]));

  /** @type {Map<string, any>} the tools the module registered */
  const tools = new Map();
  /** Holds at the fake Gate: outward tool calls, vault writes and gate.request proposals. */
  /** @type {{ id: string, kind: string, via: string, content: any, who: string, state: "held" | "approved" }[]} */
  const holds = [];
  /** Everything the module asked of the world through ctx, in order. */
  /** @type {{ member: string, [k: string]: any }[]} */
  const calls = [];
  /** @type {any[]} */
  const events = [];
  /** @type {{ level: string, message: string, extra?: unknown }[]} */
  const logs = [];
  /** What the module did that its manifest doesn't allow: the conformance test reads these. */
  /** @type {string[]} */
  const violations = [];
  /** Memory rows written through the default memory.write fake. */
  /** @type {any[]} */
  const memory = [];
  /** Registered beyond tools: providers, streams, routes (built in only). */
  const registered = { providers: /** @type {string[]} */ ([]), streams: /** @type {string[]} */ ([]), routes: /** @type {string[]} */ ([]) };
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {Map<string, Set<Function>>} */
  const settingListeners = new Map();
  const settingValues = new Map(Object.entries(opts.settings || {}));
  let spent = 0, nextHold = 0, nextEvent = 0, closed = false;
  /** The call a tool is running for, so a vault write inside a cleared outward tool isn't held twice. */
  const current = new AsyncLocalStorage();

  const db = new DatabaseSync(path.join(data, "store.db"));
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const prefix = name.replace(/-/g, "_");

  /** memory.write and push.offer answer with no setup, so a module that declares them just works. */
  /** @type {Record<string, (input: any) => any>} */
  const fakes = {
    "memory.write": row => { memory.push(row); return { id: `mem-${memory.length}` }; },
    "push.offer": () => opts.push || "sent",
  };
  /** @param {string} why */
  const violate = why => { violations.push(why); return why; };
  const hold = (/** @type {string} */ kind, /** @type {string} */ via, /** @type {any} */ content, /** @type {string} */ who) => {
    const id = `hold-${++nextHold}`;
    holds.push({ id, kind, via, content, who, state: "held" });
    return id;
  };
  /** Whether the call now running was cleared by the person: their tap, an ask, or an approval. */
  const cleared = () => { const c = current.getStore(); return Boolean(c && (c.who === "person" || c.asked || c.gate)); };

  /** Another module's tool, the way the registry routes ctx.call. @param {string} tool @param {any} input */
  const callOut = async (tool, input = {}) => {
    calls.push({ member: "call", tool, input });
    const own = entries.has(tool);
    if (!own && !needsTools.some((/** @type {string} */ p) => p === tool || (p.endsWith(".*") && tool.startsWith(p.slice(0, -1))))) {
      violate(`ctx.call ${tool}, which needs.tools does not list`);
      return { error: { code: "denied", message: `${name} may not call ${tool}: add it to needs.tools in module.json` } };
    }
    if (own) return route(tool, input, { who: "module", module: name });
    const fake = (opts.tools && opts.tools[tool]) || fakes[tool];
    if (!fake) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    try { return { data: await fake(input, { caller: `module:${name}`, who: "module" }) }; }
    catch (e) { return asError(e); }
  };

  const asError = (/** @type {any} */ e) => {
    const code = typeof e?.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(e.code) ? e.code : "failed";
    return { error: { code, message: e?.message || String(e) } };
  };

  /** @type {import("./index.d.ts").ModuleContext} */
  const ctx = /** @type {any} */ ({
    name, version: m.version,
    api: { version: 1, has: (/** @type {string} */ f) => FEATURES.includes(f) },
    log: Object.assign((/** @type {string} */ message, /** @type {unknown} */ extra) => { logs.push({ level: "info", message, extra }); },
      Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level, (/** @type {string} */ message, /** @type {unknown} */ extra) => { logs.push({ level, message, extra }); }]))),
    tool(/** @type {string} */ tool, /** @type {any} */ def) {
      if (!entries.has(tool)) throw new Error(violate(`${name} registered tool ${tool}, which its manifest does not declare under does.tools`));
      if (tools.has(tool)) throw new Error(`tool ${tool} is already registered`);
      if (!def || typeof def.run !== "function") throw new Error(`tool ${tool} needs a run function`);
      if (!firstParty && def.presence) throw new Error(violate(`tool ${tool} declares presence; presence is never a module's to declare, use reach "asked"`));
      if (!firstParty && (def.internal || def.hook)) throw new Error(violate(`tool ${tool} sets ${def.internal ? "internal" : "hook"}; declare reach "${def.internal ? "modules" : "hook"}" in module.json instead`));
      if (def.examples !== undefined && !Array.isArray(def.examples)) throw new Error(`tool ${tool}: examples must be a list of { input }`);
      tools.set(tool, { ...def, input: def.input || { type: "object" }, entry: entries.get(tool) });
    },
    call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o) => {
      if (o && o.as) throw new Error(violate(`${name} may not call ${tool} as ${o.as}`));
      return callOut(tool, input);
    },
    events: {
      emit(/** @type {string} */ type, /** @type {any} */ payload = {}, /** @type {any} */ where = {}) {
        if (!emits.includes(type)) throw new Error(violate(`${name} emitted ${type}, which its manifest does not declare under watches.emits`));
        if (RESERVED.some(p => type.startsWith(p)) || RESERVED_TYPES.includes(type)) throw new Error(violate(`${name} emitted ${type}, a family only its owner emits`));
        return deliver(type, payload, where, name);
      },
      on(/** @type {string} */ pattern, /** @type {Function} */ fn) {
        if (!firstParty && !on.some((/** @type {string} */ d) => covers(d, pattern))) throw new Error(violate(`${name} subscribed to ${pattern}, which its manifest does not declare under watches.on`));
        if (!listeners.has(pattern)) listeners.set(pattern, new Set());
        /** @type {Set<Function>} */ (listeners.get(pattern)).add(fn);
        return () => listeners.get(pattern)?.delete(fn);
      },
      since: (/** @type {number} */ id = 0, /** @type {any} */ o = {}) => events.filter(e => e.id > id && (!o.type || e.type === o.type) && (!o.project || e.project === o.project)).slice(0, o.limit || 200),
      latestId: () => nextEvent,
    },
    modules: { status: () => structuredClone([{ name, version: m.version, state: "running", use: { calls: 0, lastUsed: null } }, ...(opts.modules || [])]) },
    settings: {
      async get(/** @type {string} */ key) {
        const d = declaredSettings.get(key);
        if (!d) throw refuse("not_declared", `${name} read setting ${key}, which its manifest does not declare`);
        return settingValues.has(key) ? settingValues.get(key) : d.default;
      },
      async set(/** @type {string} */ key, /** @type {unknown} */ value) {
        const d = declaredSettings.get(key);
        if (!d) throw refuse("not_declared", `${name} set ${key}, which its manifest does not declare`);
        if (d.confirm !== undefined || d.security !== undefined) throw refuse("denied", `${key} asks the person before a change; a module can't set it`);
        settingValues.set(key, value);
        for (const fn of settingListeners.get(key) || []) { try { fn(value, { key }); } catch {} }
      },
      on(/** @type {string} */ key, /** @type {Function} */ fn) {
        if (!declaredSettings.has(key)) throw new Error(`${name} watched setting ${key}, which its manifest does not declare`);
        if (!settingListeners.has(key)) settingListeners.set(key, new Set());
        /** @type {Set<Function>} */ (settingListeners.get(key)).add(fn);
        return () => settingListeners.get(key)?.delete(fn);
      },
    },
    store: {
      db,
      /** Forward only: each step runs once, in order, and a step once run is never taken away. */
      migrate(/** @type {string[]} */ steps) {
        const done = new Set(db.prepare("SELECT version FROM _migrations WHERE module = ?").all(name).map(r => Number(r.version)));
        if (done.size > steps.length) throw new Error(`migrations are forward only: ${done.size} ran before, ${steps.length} given; add steps, never remove one`);
        steps.forEach((sql, i) => {
          const v = i + 1;
          if (done.has(v)) return;
          for (const t of sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) {
            if (!t[1].startsWith(prefix + "_") && t[1] !== prefix) throw new Error(`module ${name} tried to create table ${t[1]}; its tables must start with "${prefix}_"`);
          }
          db.exec("BEGIN");
          try { db.exec(sql); db.prepare("INSERT INTO _migrations (module, version, at) VALUES (?,?,?)").run(name, v, Date.now()); db.exec("COMMIT"); }
          catch (e) { db.exec("ROLLBACK"); throw new Error(`migration ${name} v${v} failed: ${/** @type {Error} */ (e).message}`); }
        });
      },
    },
    paths: { data },
    vault: {
      async request(/** @type {string} */ id, /** @type {any} */ req = {}) {
        if (!credentials.includes(id)) throw refuse("not_declared", violate(`${name} asked the vault for ${id}, which needs.credentials does not declare`));
        const method = String(req.method || "GET").toUpperCase();
        const write = !["GET", "HEAD"].includes(method);
        calls.push({ member: "vault.request", id, req: { ...req, method } });
        if (write && !cleared()) return { held: hold("vault", `vault.request:${id}`, { method, url: req.url, body: req.body }, current.getStore()?.who || "module") };
        const answer = typeof opts.vault === "function" ? await opts.vault(id, req) : opts.vault && opts.vault[id];
        return answer || { status: 200, headers: {}, body: { ok: true } };
      },
      async fetch() { throw new Error(violate(`${name} used ctx.vault.fetch, which is built in only; use ctx.vault.request`)); },
    },
    connections: {
      async call(/** @type {string} */ provider, /** @type {string} */ tool, /** @type {any} */ input = {}) {
        if (!connections.includes(provider)) throw refuse("not_declared", violate(`${name} called the ${provider} connection, which needs.connections does not declare`));
        calls.push({ member: "connections.call", provider, tool, input });
        try { return { data: opts.connections ? await opts.connections(provider, tool, input) : null }; } catch (e) { return asError(e); }
      },
    },
    async fetch(/** @type {string} */ url, /** @type {any} */ init = {}) {
      let u;
      try { u = new URL(url); } catch { throw refuse("bad_input", `${url} is not a URL`); }
      if (PRIVATE.some(re => re.test(u.hostname))) throw refuse("denied", `${u.hostname} is a private address; ctx.fetch reaches only public hosts`);
      if (!hostAllowed(network, u)) throw refuse("not_declared", violate(`${name} fetched ${u.host}, which needs.network does not list`));
      calls.push({ member: "fetch", url, init });
      const r = (opts.fetch && await opts.fetch(url, init)) || {};
      const body = r.body === undefined ? "" : r.body;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status: r.status || 200, headers: r.headers || {}, text: async () => text, json: async () => JSON.parse(text) };
    },
    gate: {
      async request(/** @type {any} */ req) {
        calls.push({ member: "gate.request", req });
        if (current.getStore()?.asked) return { sent: true };
        return { held: hold(String(req && req.kind), String(req && req.via), req && req.content, current.getStore()?.who || "module") };
      },
    },
    memory: {
      write: async (/** @type {any} */ row) => {
        const r = await callOut("memory.write", { ...row, from: `module:${name}`, ...(firstParty ? {} : { untrusted: true }) });
        return r;
      },
      teach: async (/** @type {string} */ kind, /** @type {unknown} */ fact) => {
        const r = await callOut("memory.write", { kind: "fact", text: typeof fact === "string" ? fact : JSON.stringify(fact), subject: kind, from: `module:${name}`, ...(firstParty ? {} : { untrusted: true }) });
        return !r.error;
      },
    },
    async ask(/** @type {string} */ prompt, /** @type {any} */ o = {}) {
      if (!o || typeof o.purpose !== "string") throw refuse("bad_input", "ctx.ask needs { purpose }");
      calls.push({ member: "ask", prompt, opts: o });
      if (capUsd !== null && spent >= capUsd) return { error: { code: "capped", message: `${name} reached its $${capUsd} daily cap` } };
      const r = (opts.ask && await opts.ask(prompt, o)) || { text: "", usd: 0 };
      spent += Number(r.usd) || 0;
      return r;
    },
    spend: {
      async record(/** @type {any} */ e) {
        if (!e || typeof e.usd !== "number" || e.usd < 0 || typeof e.purpose !== "string") throw refuse("bad_input", "spend.record needs { usd, purpose }");
        calls.push({ member: "spend.record", ...e });
        spent += e.usd;
      },
      async check(/** @type {string} */ purpose) {
        calls.push({ member: "spend.check", purpose });
        return { ok: capUsd === null || spent < capUsd, spentUsd: spent, capUsd };
      },
    },
    push: {
      async offer(/** @type {any} */ n) {
        if (!n || typeof n.title !== "string" || typeof n.kind !== "string") throw refuse("bad_input", "push.offer needs { title, body, kind }");
        const r = await callOut("push.offer", n);
        if (r.error && r.error.code !== "no_such_tool") throw refuse(r.error.code, r.error.message);
        return r.data === "deferred" || r.data === "sent" ? r.data : opts.push || "sent";
      },
    },
    undo: {
      async record(/** @type {any} */ e) {
        if (!e || !e.inverse || typeof e.inverse.tool !== "string") throw refuse("bad_input", "undo.record needs { tool, input, inverse: { tool, input } }");
        calls.push({ member: "undo.record", ...e });
      },
    },
  });

  // Built in only in 0.2 (ADR 0047 section 3). An added module gets a clear refusal, not a TypeError.
  const builtIn = (/** @type {string} */ member, /** @type {keyof typeof registered} */ list, /** @type {string[]} */ declared) => (/** @type {string} */ n) => {
    if (!firstParty) throw new Error(violate(`ctx.${member} is built in only in 0.2`));
    if (!declared.includes(n)) throw new Error(violate(`${name} registered ${member} ${n}, which its manifest does not declare`));
    registered[list].push(n);
  };
  ctx.provider = /** @type {any} */ (builtIn("provider", "providers", (m.does && m.does.providers) || []));
  ctx.upgrade = /** @type {any} */ (builtIn("upgrade", "streams", (m.shows && m.shows.streams) || []));
  ctx.route = /** @type {any} */ ((/** @type {string} */ n) => {
    if (!firstParty) throw new Error(violate("ctx.route is built in only in 0.2"));
    registered.routes.push(n);
  });

  /** An event into the log and to every listener. @param {string} type @param {any} payload @param {any} where @param {string} source */
  function deliver(type, payload = {}, where = {}, source = "test") {
    const event = { id: ++nextEvent, type, source, at: Date.now(), project: where.project || null, thread: where.thread || null, payload };
    events.push(event);
    for (const key of [type, type.split(".")[0] + ".*", "*"]) for (const fn of listeners.get(key) || []) { try { fn(event); } catch {} }
    return event;
  }

  /**
   * A call to one of this module's tools, routed as the registry routes it (ADR 0047 section 2).
   * @param {string} tool @param {any} input @param {As & { gate?: "approved", content?: any }} as
   */
  async function route(tool, input = {}, as = {}) {
    const who = as.who || "person";
    const def = tools.get(tool);
    const hidden = { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    if (!def) return hidden;
    const { reach, outward } = def.entry;
    // Hidden reaches are not there at all for the wrong caller; the others say why.
    if ((reach === "hook") !== (who === "hook")) return hidden;
    if (reach === "modules" && who !== "module") return hidden;
    if (reach === "person" && who !== "person") return { error: { code: who === "agent" ? "person_only" : "denied", message: `${tool} is the person's own; ask them to do it` } };
    if (reach === "asked" && who === "module") return { error: { code: "denied", message: `${tool} is not available to modules` } };
    if (reach === "asked" && who === "agent" && !as.asked) return { error: { code: "not_asked", message: `${tool} runs for an agent only when the person asked for it; tell them what you would do` } };
    const problems = checkSchema(def.input, input, "input");
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    /** @type {"person" | "asked" | "approved" | undefined} */
    let gate;
    if (outward) {
      if (as.gate === "approved") gate = "approved";
      else if (who === "person") gate = "person";
      else if (who === "agent" && as.asked) gate = "asked";
      else return { held: hold(outward, tool, input, who) };
    }
    const caller = as.gate === "approved" ? "module:gate" : who === "person" ? "deck" : who === "agent" ? `mcp:agent:${as.agent || "kit"}` : who === "module" ? `module:${as.module || "other"}` : "hook";
    const meta = { caller, who: as.gate === "approved" ? "module" : who, ...(as.agent || who === "agent" ? { agent: as.agent || "kit" } : {}),
      ...(as.thread ? { thread: as.thread } : {}), ...(as.project ? { project: as.project } : {}), asked: Boolean(as.asked), ...(gate ? { gate } : {}) };
    return current.run(meta, async () => {
      try { return { data: await def.run(input, meta) }; }
      catch (e) { return asError(e); }
    });
  }

  return {
    ctx, home, dir: home, holds, calls, events, logs, memory, violations, tools, registered,
    /** Call one of this module's tools as the person (default), an agent, another module or the webhook. */
    call: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {As} */ as = {}) => route(tool, input, as),
    /** Approve a held outward call, as the person at the Gate: it runs as module:gate, with content they may have edited. */
    async approve(/** @type {string} */ id, /** @type {any} */ content) {
      const h = holds.find(x => x.id === id && x.state === "held");
      if (!h) return { error: { code: "not_found", message: `no hold ${id}` } };
      h.state = "approved";
      if (!tools.has(h.via)) return { data: null };
      return route(h.via, content === undefined ? h.content : content, { who: "module", gate: "approved" });
    },
    /** An event from elsewhere, delivered to the module's subscriptions. */
    deliver: (/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ where) => deliver(type, payload, where, "test"),
    /** Close the store and remove the temp home this harness made. */
    async stop() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch {}
      if (made) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Start the module in a folder with createTestContext() and return the harness around it.
 * @param {string} dir the module's folder (module.json and its entry file)
 * @param {Options} [opts]
 */
export async function testModule(dir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8"));
  const t = createTestContext(manifest, opts);
  const entry = path.resolve(dir, manifest.main || "index.js");
  const mod = (await import(pathToFileURL(entry).href)).default;
  if (!mod || typeof mod.start !== "function") { await t.stop(); throw new Error("the entry file must export default { start(ctx) }"); }
  let handle;
  try { handle = await mod.start(t.ctx); }
  catch (e) { await t.stop(); throw e; }
  return {
    ...t, manifest, module: mod, handle, moduleDir: dir,
    /** Stop the module, then close the store and remove the temp home. */
    async stop() {
      try { if (handle && typeof handle.stop === "function") await handle.stop(); }
      finally { await t.stop(); }
    },
  };
}
