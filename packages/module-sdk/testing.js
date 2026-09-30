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
// needs.tools, the vault only for needs.credentials, fetch only to needs.network, memory only
// for teaches.memory kinds, push only for shows.notices kinds, ask and spend only with
// needs.spend. A door used without its declaration throws code "undeclared" (ADR 0047 section 3). Everything that
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
import { createHash } from "node:crypto";
import { checkSchema, toolEntries } from "./manifest.js";
import { CONTRACT, supports, moduleContract, adapterFor } from "./contract.js";

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
 * Who a test call comes from. The person on their own surface, a tap on a control the module drew
 * (slot), an agent (asked: the person's own words in their own turn asked for exactly this), another
 * module (added: an added module, held to default-deny), or the webhook route.
 * @typedef {{ who?: "person" | "slot" | "agent" | "module" | "hook", asked?: boolean, added?: boolean, agent?: string, module?: string,
 *   project?: string, thread?: string, item?: string }} As
 */

/**
 * What the fakes answer. Every key is optional; each fake has a plain default.
 * @typedef {{
 *   home?: string, firstParty?: boolean, contract?: string,
 *   tools?: Record<string, ((input: any, meta: any) => any) | { reach?: string, run: (input: any, meta: any) => any }>,
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
  if (!manifest || typeof manifest.name !== "string") throw new Error("createTestContext needs a manifest with a name");
  // The contract this harness speaks, and the adapter the module's own contract goes through
  // (compat/v<major>.js; the identity for contract 1 today).
  const contract = opts.contract || CONTRACT.current;
  const named = moduleContract(manifest);
  const ok = supports(named, { name: manifest.name, contract });
  if (!ok.ok) throw Object.assign(new Error(ok.message), { code: "unsupported" });
  const adapter = adapterFor(named);
  const m = adapter.manifest(manifest);
  const name = m.name, firstParty = Boolean(opts.firstParty);
  const made = !opts.home;
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), `vyre-module-${name}-`));
  const data = path.join(home, "data", name);
  fs.mkdirSync(data, { recursive: true });

  const entries = new Map(toolEntries(m).map(e => [e.name, e]));
  /** Tools with a declared reach (an object entry); a string entry is grace form. */
  const objectForm = new Set(((m.does && m.does.tools) || []).filter((/** @type {any} */ e) => e && typeof e === "object").map((/** @type {any} */ e) => e.name));
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
  /** Deprecated usages at run time: they work, and warn (ADR 0047 section 8). */
  /** @type {string[]} */
  const warnings = [];
  const warnOnce = (/** @type {string} */ w) => { if (!warnings.includes(w)) warnings.push(w); };
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

  /** memory.write answers with no setup, so a module that declares its kinds just works. */
  /** @type {Record<string, (input: any) => any>} */
  const fakes = {
    "memory.write": row => { memory.push(row); return { id: `mem-${memory.length}` }; },
  };
  /** @param {string} why */
  const violate = why => { violations.push(why); return why; };
  /**
   * Each ctx door has one declaration (ADR 0047 section 3); a call without it throws undeclared.
   * @param {string} why
   */
  const undeclared = why => refuse("undeclared", violate(`${name}: ${why}`));
  const memoryKinds = (m.teaches && Array.isArray(m.teaches.memory)) ? m.teaches.memory : [];
  const notices = (m.shows && Array.isArray(m.shows.notices)) ? m.shows.notices : [];
  /** source: who asked, or "slot" for a tap on a control the module drew (a gate card, H5). */
  const hold = (/** @type {string} */ kind, /** @type {string} */ via, /** @type {any} */ content, /** @type {string} */ who, source = who) => {
    const id = `hold-${++nextHold}`;
    holds.push({ id, kind, via, content, who, source, state: "held" });
    return id;
  };
  /**
   * Gate items that cleared an outward run (the person's words, a P17 match, an approval). Each
   * lets exactly one vault or connection write through (ADR 0047 section 2, M3); `write` is its
   * fingerprint once used. An approved vault hold instead expects the write it held.
   * @type {Map<string, { id: string, via: string, used: boolean, write: any, expect?: any }>}
   */
  const gateItems = new Map();
  let nextItem = 0;
  const hash = (/** @type {unknown} */ body) => createHash("sha256").update(JSON.stringify(body === undefined ? null : body)).digest("hex");
  /**
   * A write out (vault or connection): through at once when an approved hold expects exactly it, or
   * when the call now running holds an unused Gate item; held otherwise.
   * @param {{ method: string, url: string, body: unknown }} w @param {string} kind @param {string} via
   * @returns {string | null} a hold id, or null when the write may go
   */
  const gateWrite = (w, kind, via) => {
    const fp = { method: w.method, url: w.url, body: hash(w.body) };
    const same = (/** @type {any} */ x) => x && x.method === fp.method && x.url === fp.url && x.body === fp.body;
    const expected = [...gateItems.values()].find(i => i.expect && !i.used && same(i.expect));
    if (expected) { expected.used = true; expected.write = fp; return null; }
    const c = current.getStore(), item = c && c.gate ? gateItems.get(c.gate.item) : null;
    if (item && !item.used) { item.used = true; item.write = fp; return null; }
    return hold(kind, via, { method: w.method, url: w.url, body: w.body }, (c && c.who) || "module");
  };
  /** MCP tools that change something outside, for a connection call's Gate check. */
  const MCP_WRITE = /(^|[._-])(create|update|delete|remove|send|post|write|merge|close|add|set|put|patch)/i;

  /** Another module's tool, the way the registry routes ctx.call. @param {string} tool @param {any} input */
  const callOut = async (tool, input = {}) => {
    calls.push({ member: "call", tool, input });
    const own = entries.has(tool);
    if (!own && !needsTools.some((/** @type {string} */ p) => p === tool || (p.endsWith(".*") && tool.startsWith(p.slice(0, -1))))) {
      throw undeclared(`ctx.call ${tool}, which needs.tools does not list`);
    }
    if (own) return route(tool, input, { who: "module", module: name });
    const given = (opts.tools && opts.tools[tool]) || fakes[tool];
    if (!given) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    // A fake is a function (a grace-form tool, no declared reach) or { reach, run }. An added
    // module reaches only a declared anyone or asked tool (H4).
    const fake = typeof given === "function" ? given : given.run;
    const reach = typeof given === "function" ? null : given.reach || null;
    if (!firstParty && (reach === null || reach === "modules")) return { error: { code: "not_declared", message: `${tool} is not open to added modules` } };
    if (reach === "person" || reach === "hook") return { error: { code: "denied", message: `${tool} is not available to modules` } };
    try { return { data: await fake(input, { caller: `module:${name}`, who: "module" }) }; }
    catch (e) { return asError(e); }
  };

  /** A memory row through the memory.write fake, as iq's memory.write takes it. @param {any} row */
  const writeMemory = async row => {
    calls.push({ member: "memory.write", input: row });
    const fake = (opts.tools && opts.tools["memory.write"]) || fakes["memory.write"];
    try { return { data: await fake(row, { caller: `module:${name}`, who: "module" }) }; }
    catch (e) { return asError(e); }
  };

  const asError = (/** @type {any} */ e) => {
    const code = typeof e?.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(e.code) ? e.code : "failed";
    return { error: { code, message: e?.message || String(e) } };
  };

  /** @type {import("./index.d.ts").ModuleContext} */
  const ctx = /** @type {any} */ ({
    name, version: m.version,
    api: { version: contract, has: (/** @type {string} */ f) => FEATURES.includes(f) },
    log: Object.assign((/** @type {string} */ message, /** @type {unknown} */ extra) => { logs.push({ level: "info", message, extra }); },
      Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level, (/** @type {string} */ message, /** @type {unknown} */ extra) => { logs.push({ level, message, extra }); }]))),
    tool(/** @type {string} */ tool, /** @type {any} */ def) {
      if (!entries.has(tool)) throw undeclared(`registered tool ${tool}, which its manifest does not declare under does.tools`);
      if (tools.has(tool)) throw new Error(`tool ${tool} is already registered`);
      if (!def || typeof def.run !== "function") throw new Error(`tool ${tool} needs a run function`);
      if (!firstParty && def.presence) throw new Error(violate(`tool ${tool} declares presence; presence is never a module's to declare, use reach "asked"`));
      if (!firstParty && (def.internal || def.hook)) throw new Error(violate(`tool ${tool} sets ${def.internal ? "internal" : "hook"}; declare reach "${def.internal ? "modules" : "hook"}" in module.json instead`));
      if (!firstParty && def.callers) throw new Error(violate(`tool ${tool} sets callers; declare reach in module.json instead`));
      if (firstParty && (def.callers || def.internal)) warnOnce(`tool ${tool} sets ${def.callers ? "callers" : "internal"}, which is deprecated; declare reach in module.json`);
      if (def.examples !== undefined && !Array.isArray(def.examples)) throw new Error(`tool ${tool}: examples must be a list of { input }`);
      tools.set(tool, { ...def, input: def.input || { type: "object" }, entry: entries.get(tool), declared: objectForm.has(tool) });
    },
    call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o) => {
      if (o && o.as) throw new Error(violate(`${name} may not call ${tool} as ${o.as}`));
      return callOut(tool, input);
    },
    events: {
      emit(/** @type {string} */ type, /** @type {any} */ payload = {}, /** @type {any} */ where = {}) {
        if (!emits.includes(type)) throw undeclared(`emitted ${type}, which its manifest does not declare under watches.emits`);
        if (RESERVED.some(p => type.startsWith(p)) || RESERVED_TYPES.includes(type)) throw new Error(violate(`${name} emitted ${type}, a family only its owner emits`));
        return deliver(type, payload, where, name);
      },
      on(/** @type {string} */ pattern, /** @type {Function} */ fn) {
        if (!firstParty && !on.some((/** @type {string} */ d) => covers(d, pattern))) throw undeclared(`subscribed to ${pattern}, which its manifest does not declare under watches.on`);
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
        if (!d) throw refuse("undeclared", `${name} read setting ${key}, which its manifest does not declare`);
        return settingValues.has(key) ? settingValues.get(key) : d.default;
      },
      async set(/** @type {string} */ key, /** @type {unknown} */ value) {
        const d = declaredSettings.get(key);
        if (!d) throw refuse("undeclared", `${name} set ${key}, which its manifest does not declare`);
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
        if (!credentials.includes(id)) throw undeclared(`asked the vault for ${id}, which needs.credentials does not declare`);
        const method = String(req.method || "GET").toUpperCase();
        const write = !["GET", "HEAD"].includes(method);
        calls.push({ member: "vault.request", id, req: { ...req, method } });
        if (write) {
          const held = gateWrite({ method, url: String(req.url), body: req.body }, "vault", `vault.request:${id}`);
          if (held) return { held };
        }
        const answer = typeof opts.vault === "function" ? await opts.vault(id, req) : opts.vault && opts.vault[id];
        return answer || { status: 200, headers: {}, body: { ok: true } };
      },
      async fetch() { throw new Error(violate(`${name} used ctx.vault.fetch, which is built in only; use ctx.vault.request`)); },
    },
    connections: {
      async call(/** @type {string} */ provider, /** @type {string} */ tool, /** @type {any} */ input = {}) {
        if (!connections.includes(provider)) throw undeclared(`called the ${provider} connection, which needs.connections does not declare`);
        calls.push({ member: "connections.call", provider, tool, input });
        if (MCP_WRITE.test(tool)) {
          const held = gateWrite({ method: "MCP", url: `${provider}/${tool}`, body: input }, "connection", `connections.call:${provider}`);
          if (held) return { held };
        }
        try { return { data: opts.connections ? await opts.connections(provider, tool, input) : null }; } catch (e) { return asError(e); }
      },
    },
    async fetch(/** @type {string} */ url, /** @type {any} */ init = {}) {
      // GET and HEAD only, with no body (H3): sending data out goes through ctx.vault.request or an
      // outward tool, where the Gate sees it. A webhook URL can't be posted to this way (L1).
      const method = String((init && init.method) || "GET").toUpperCase();
      if (!["GET", "HEAD"].includes(method) || (init && init.body !== undefined)) throw refuse("method_not_allowed", `ctx.fetch sends GET or HEAD with no body; to send data use ctx.vault.request or an outward tool`);
      let u;
      try { u = new URL(url); } catch { throw refuse("bad_input", `${url} is not a URL`); }
      if (PRIVATE.some(re => re.test(u.hostname))) throw refuse("denied", `${u.hostname} is a private address; ctx.fetch reaches only public hosts`);
      if (!hostAllowed(network, u)) throw undeclared(`fetched ${u.host}, which needs.network does not list`);
      calls.push({ member: "fetch", url, init });
      const r = (opts.fetch && await opts.fetch(url, init)) || {};
      const body = r.body === undefined ? "" : r.body;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status: r.status || 200, headers: r.headers || {}, text: async () => text, json: async () => JSON.parse(text) };
    },
    gate: {
      async request(/** @type {any} */ req) {
        if (!needsTools.includes("gate.request")) throw undeclared("ctx.gate.request, but needs.tools does not list gate.request");
        calls.push({ member: "gate.request", req });
        if (current.getStore()?.asked) return { sent: true };
        return { held: hold(String(req && req.kind), String(req && req.via), req && req.content, current.getStore()?.who || "module") };
      },
    },
    memory: {
      write: async (/** @type {any} */ row) => {
        const kind = row && row.kind;
        if (!memoryKinds.includes(kind)) throw undeclared(`ctx.memory.write a ${kind}, which teaches.memory does not list`);
        return writeMemory({ ...row, from: `module:${name}`, ...(firstParty ? {} : { untrusted: true }) });
      },
      // Deprecated alias: a fact, declared as "fact" or under its old kind in teaches.memory.
      teach: async (/** @type {string} */ kind, /** @type {unknown} */ fact) => {
        warnOnce("ctx.memory.teach is deprecated; use ctx.memory.write({ kind: \"fact\", text })");
        if (!memoryKinds.includes("fact") && !memoryKinds.includes(kind)) throw undeclared(`ctx.memory.teach ${kind}, which teaches.memory does not list`);
        const r = await writeMemory({ kind: "fact", text: typeof fact === "string" ? fact : JSON.stringify(fact), subject: kind, from: `module:${name}`, ...(firstParty ? {} : { untrusted: true }) });
        return !r.error;
      },
    },
    async ask(/** @type {string} */ prompt, /** @type {any} */ o = {}) {
      if (capUsd === null) throw undeclared("ctx.ask, but needs.spend declares no daily cap");
      if (!o || typeof o.purpose !== "string") throw refuse("bad_input", "ctx.ask needs { purpose }");
      calls.push({ member: "ask", prompt, opts: o });
      if (capUsd !== null && spent >= capUsd) return { error: { code: "capped", message: `${name} reached its $${capUsd} daily cap` } };
      const r = (opts.ask && await opts.ask(prompt, o)) || { text: "", usd: 0 };
      spent += Number(r.usd) || 0;
      return r;
    },
    spend: {
      async record(/** @type {any} */ e) {
        if (capUsd === null) throw undeclared("ctx.spend.record, but needs.spend declares no daily cap");
        if (!e || typeof e.usd !== "number" || e.usd < 0 || typeof e.purpose !== "string") throw refuse("bad_input", "spend.record needs { usd, purpose }");
        calls.push({ member: "spend.record", ...e });
        spent += e.usd;
      },
      async check(/** @type {string} */ purpose) {
        if (capUsd === null) throw undeclared("ctx.spend.check, but needs.spend declares no daily cap");
        calls.push({ member: "spend.check", purpose });
        return { ok: spent < capUsd, spentUsd: spent, capUsd };
      },
    },
    push: {
      async offer(/** @type {any} */ n) {
        if (!n || typeof n.title !== "string" || typeof n.kind !== "string") throw refuse("bad_input", "push.offer needs { title, body, kind }");
        if (!notices.includes(n.kind)) throw undeclared(`ctx.push.offer a ${n.kind} notice, which shows.notices does not list`);
        calls.push({ member: "push.offer", input: n });
        const fake = opts.tools && opts.tools["push.offer"];
        const r = fake ? await fake(n, { caller: `module:${name}`, who: "module" }) : opts.push;
        return r === "deferred" ? "deferred" : "sent";
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
    // Default-deny for an added module's call (H4): only a declared reach is open to it, and
    // reach modules is for Vyre's own modules only.
    if (who === "module" && as.added && (!def.declared || reach === "modules")) return { error: { code: "not_declared", message: `${tool} is not open to added modules` } };
    // Hidden reaches are not there at all for the wrong caller; the others say why.
    if ((reach === "hook") !== (who === "hook")) return hidden;
    if (reach === "modules" && who !== "module") return hidden;
    // A tap on a control the module drew (a Now card action, a renderer button, a Capsule action)
    // is the person's tap for anything but an outward tool, which gets vyred's own Gate card (H5).
    const tap = who === "slot";
    if (reach === "person" && who !== "person" && !tap) return { error: { code: who === "agent" ? "person_only" : "denied", message: `${tool} is the person's own; ask them to do it` } };
    if (reach === "asked" && who === "module") return { error: { code: "denied", message: `${tool} is not available to modules` } };
    if (reach === "asked" && who === "agent" && !as.asked) return { error: { code: "not_asked", message: `${tool} runs for an agent only when the person asked for it; tell them what you would do` } };
    const problems = checkSchema(def.input, input, "input");
    if (problems.length) return { error: { code: "bad_input", message: problems.join("; ") } };
    /** @type {{ via: "person" | "asked" | "approved", item: string } | undefined} */
    let gate;
    if (outward) {
      /** @type {"person" | "asked" | "approved" | null} */
      const via = as.gate === "approved" ? "approved" : who === "person" ? "person" : who === "agent" && as.asked ? "asked" : null;
      if (!via) return { held: hold(outward, tool, input, tap ? "person" : who, tap ? "slot" : who) };
      const item = as.item || `gate-${++nextItem}`;
      gateItems.set(item, { id: item, via: tool, used: false, write: null });
      gate = { via, item };
    }
    const caller = as.gate === "approved" ? "module:gate" : who === "person" || tap ? "deck" : who === "agent" ? `mcp:agent:${as.agent || "kit"}` : who === "module" ? `module:${as.module || "other"}` : "hook";
    const meta = { caller, who: as.gate === "approved" ? "module" : tap ? "person" : who, ...(tap ? { slot: true } : {}), ...(as.agent || who === "agent" ? { agent: as.agent || "kit" } : {}),
      ...(as.thread ? { thread: as.thread } : {}), ...(as.project ? { project: as.project } : {}), asked: Boolean(as.asked), ...(gate ? { gate } : {}) };
    return current.run(meta, async () => {
      try { return { data: await def.run(input, meta) }; }
      catch (e) { return asError(e); }
    });
  }

  return {
    ctx: adapter.context(ctx), home, dir: home, holds, calls, events, logs, memory, violations, warnings, tools, registered, gateItems, adapter,
    /** Call one of this module's tools as the person (default), an agent, another module or the webhook. */
    call: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {As} */ as = {}) => route(tool, input, as),
    /** Approve a held outward call, as the person at the Gate: it runs as module:gate, with content they may have edited. */
    async approve(/** @type {string} */ id, /** @type {any} */ content) {
      const h = holds.find(x => x.id === id && x.state === "held");
      if (!h) return { error: { code: "not_found", message: `no hold ${id}` } };
      h.state = "approved";
      // A held write: the module's retry of exactly this write goes through once (M3).
      if (!tools.has(h.via)) {
        const c = h.content || {};
        gateItems.set(id, { id, via: h.via, used: false, write: null, expect: { method: c.method, url: c.url, body: hash(c.body) } });
        return { data: null };
      }
      return route(h.via, content === undefined ? h.content : content, { who: "module", gate: "approved", item: id });
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
  // Checked before anything is imported: a module for a newer contract never runs here either.
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
