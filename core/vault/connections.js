// @ts-check
// connections: every account and key the system can act through, in one table, with the
// surfaces allowed to use each (ADR 0028, decision 9b).
//
// A connection is a provider, an account, an auth kind, capabilities and surfaces. Two kinds of
// row share the table:
// - source "vault": an item whose details.provider names a catalog provider (vault.connect makes
//   these). The vault writes these rows itself and resyncs them on vault.connected and on its
//   own put and delete events. Nothing polls.
// - source "<module>": a row a module registered (vault.connections.register). The source is the
//   calling module's name, from its caller label and never from its input, so a module can only
//   ever write and remove its own rows. The id is stable across upserts.
// A person's edits (the label, the capabilities and the surfaces) survive a resync or a
// re-register.
//
// Surfaces: capsule, chat, agents, phone. A new connection is granted to capsule and chat.
// cli, local and deck are the person at a settings screen and see everything. Rows are MACed
// like the grant rows (vault.js MACED); a row whose MAC fails is granted to no surface, and a
// resync or re-register rewrites it with no surfaces rather than signing what someone else wrote.
//
// What leaves: names, providers, account addresses, capabilities, surfaces, states and which
// tool to call. Never a value, and never the name of a field that holds one.

import crypto from "node:crypto";
import { provider as catalog, CAPABILITIES } from "./providers.js";

/** The vault_connections table (vault.js appends it to MIGRATIONS). */
export const CONNECTIONS_MIGRATION = `CREATE TABLE vault_connections (
     id TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL,
     auth TEXT NOT NULL, label TEXT NOT NULL, capabilities TEXT NOT NULL, surfaces TEXT NOT NULL,
     added INTEGER NOT NULL, updated INTEGER NOT NULL, mac TEXT,
     items TEXT NOT NULL DEFAULT '[]', use TEXT, edited TEXT NOT NULL DEFAULT '[]', UNIQUE (source, ref)
   );`;

/** The MACed columns: which connection it is, what it can do and who may use it. */
export const CONNECTION_MACED = ["id", "source", "ref", "provider", "account", "auth", "capabilities", "surfaces"];

/** Sources the vault reads itself, in sync order. */
export const SYNCED = ["google", "mcp", "vault"];
export const SURFACE_NAMES = /** @type {const} */ (["capsule", "chat", "agents", "phone"]);
export const DEFAULT_SURFACES = ["capsule", "chat"];
export const AUTHS = /** @type {const} */ (["oauth", "service-account", "api-key", "password", "bearer", "none"]);

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const newId = () => "cn_" + crypto.randomBytes(9).toString("base64url");
const cut = (s, n) => String(s ?? "").slice(0, n);
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const ITEM = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
const fail = (message, code = "bad_input") => Object.assign(new Error(message), { code });

/** The vault item kind each auth kind of a vault row comes from. */
const AUTH_OF_KIND = { "api-key": "api-key", pat: "bearer", oauth: "oauth", cloud: "service-account", "env-set": "password", login: "password" };

// ---- surfaces -----------------------------------------------------------------------------

/**
 * Which surface a caller is, before any thread lookup. "person" sees everything; "module" is a
 * module acting as itself; null is no surface. `mcp:thread:<id>` is chat until its thread says
 * it came from the Capsule.
 * @param {string} caller
 * @returns {{ surface: "person"|"module"|"capsule"|"chat"|"agents"|"phone"|null, thread?: string }}
 */
export function surfaceOf(caller) {
  const c = String(caller ?? "");
  if (c === "cli" || c === "local" || c === "deck") return { surface: "person" };
  if (c.startsWith("module:")) return { surface: "module" };
  if (c === "capsule") return { surface: "capsule" };
  if (c === "mobile") return { surface: "phone" };
  if (c === "mcp") return { surface: "chat" };
  const th = /^mcp:thread:(.+)$/s.exec(c);
  if (th) return { surface: "chat", thread: th[1] };
  if (/^(mcp|tailnet|harness):agent:./.test(c)) return { surface: "agents" };
  // The owner on their own device at the box's tailnet address (core/names): the owner's Deck.
  if (/^tailnet:[^:]+$/.test(c)) return { surface: "person" };
  return { surface: null };
}

// ---- capabilities from tool names ---------------------------------------------------------

/** A tool name's words: snake, kebab, dots and camelCase all split, lowercased. @param {string} name */
export const words = name => String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const MAIL = ["mail", "email", "emails", "gmail", "inbox", "imap", "smtp", "outlook"];
const MSG = ["message", "messages", "thread", "threads"];
const SEND = ["send", "reply", "forward"];
const READ = ["search", "list", "read", "get", "fetch", "find"];
const CHAT = ["slack", "channel", "channels"];
const has = (ws, list) => ws.some(w => list.includes(w));

/**
 * The pattern table: each rule takes a tool's words and whether its server is a mail server
 * (its name, or another of its tools, says mail), and names one capability. In a mail server
 * "send_message" sends mail; anywhere else it sends a chat message.
 * @type {{ capability: string, test: (ws: string[], mailish: boolean) => boolean }[]}
 */
export const TOOL_PATTERNS = [
  { capability: "send_mail", test: (ws, m) => has(ws, SEND) && !has(ws, CHAT) && (has(ws, MAIL) || (m && has(ws, MSG))) },
  { capability: "read_mail", test: (ws, m) => has(ws, READ) && !has(ws, CHAT) && (has(ws, MAIL) || (m && has(ws, MSG))) },
  { capability: "calendar", test: ws => has(ws, ["calendar", "calendars", "event", "events"]) },
  { capability: "files", test: ws => has(ws, ["drive", "file", "files", "folder", "folders", "document", "documents"]) },
  { capability: "send_message", test: (ws, m) => has(ws, ["slack"]) || (ws.includes("post") && has(ws, ["message", "messages"]))
    || (!m && has(ws, ["send", "post"]) && has(ws, ["message", "messages", "chat", "dm"])) },
  { capability: "search", test: (ws, m) => ws.includes("search") && !has(ws, MAIL) && !(m && has(ws, MSG))
    && !has(ws, ["file", "files", "drive", "folder", "document", "documents", "event", "events", "calendar"]) },
];

/**
 * Capabilities from a list of tool names, and the first tool that gives each.
 * @param {string[]} tools @param {string} [name] the server or account name, as a hint
 * @returns {Record<string, string>} capability -> tool
 */
export function toolCapabilities(tools, name = "") {
  const list = (Array.isArray(tools) ? tools : []).map(t => ({ tool: String(t), ws: words(t) }));
  const mailish = has(words(name), MAIL) || list.some(t => has(t.ws, MAIL));
  /** @type {Record<string, string>} */
  const out = {};
  for (const t of list) for (const p of TOOL_PATTERNS) if (!(p.capability in out) && p.test(t.ws, mailish)) out[p.capability] = t.tool;
  return out;
}

/**
 * A Google account's capabilities, trimmed by its scopes when the row lists them.
 * @param {any} row
 */
export function googleCapabilities(row) {
  const all = ["send_mail", "read_mail", "calendar"];
  const raw = row && (Array.isArray(row.scopes) ? row.scopes : row.auth && Array.isArray(row.auth.scopes) ? row.auth.scopes : null);
  if (!raw) return all;
  const s = raw.map(x => String(x).replace(/^https:\/\/www\.googleapis\.com\/auth\//, ""));
  const full = s.some(x => /mail\.google\.com/.test(x));
  const out = [];
  if (full || s.some(x => /^gmail\.(send|compose|modify)$/.test(x))) out.push("send_mail");
  if (full || s.some(x => /^gmail\.(readonly|modify|metadata)$/.test(x))) out.push("read_mail");
  if (s.some(x => /^calendar(\.|$)/.test(x))) out.push("calendar");
  return out;
}

/** Mail capabilities with no `use` of their own go through the mail module, by connection id. */
const MAIL_USE = { send_mail: "mail.send", read_mail: "mail.search" };

/**
 * Each capability's use: the row's own `use` entry, or for send_mail and read_mail the mail
 * module's tool with the connection id. A capability with neither has no use.
 * @param {{ id: string }} row @param {string[]} capabilities @param {Record<string, any>|null} stored
 */
export function usesOf(row, capabilities, stored) {
  /** @type {Record<string, { tool: string, input: any }>} */
  const out = {};
  for (const c of capabilities) {
    const own = stored && stored[c];
    if (own) out[c] = own;
    else if (MAIL_USE[/** @type {keyof typeof MAIL_USE} */ (c)]) out[c] = { tool: MAIL_USE[/** @type {keyof typeof MAIL_USE} */ (c)], input: { account: row.id } };
  }
  return out;
}

/** Check a `use` map: {capability: {tool, input}}. Returns it cleaned, or throws. @param {any} use */
export function checkUse(use) {
  if (use === undefined || use === null) return null;
  const bad = () => fail("use must be a map of capability to {tool, input}: the tool that acts on this connection and its fixed input");
  if (typeof use !== "object" || Array.isArray(use)) throw bad();
  /** @type {Record<string, { tool: string, input: any }>} */
  const out = {};
  for (const [c, u] of Object.entries(use)) {
    if (!CAPABILITIES.includes(/** @type {any} */ (c))) throw fail(`use names ${cut(c, 40)}, which is not a capability; they are ${CAPABILITIES.join(", ")}`);
    if (!u || typeof u !== "object" || !TOOL.test(String(u.tool ?? "")) || (u.input !== undefined && (typeof u.input !== "object" || Array.isArray(u.input) || u.input === null))) throw bad();
    out[c] = { tool: String(u.tool), input: u.input || {} };
  }
  if (JSON.stringify(out).length > 4000) throw fail("use is too large");
  return Object.keys(out).length ? out : null;
}

// ---- the table ----------------------------------------------------------------------------

export class Connections {
  /**
   * @param {import("./vault.js").Vault} vault
   * @param {{ call?: (tool: string, input: any) => Promise<any>, modules?: () => any[], log?: (m: string) => void }} deps
   */
  constructor(vault, deps = {}) {
    this.v = vault;
    this.db = vault.db;
    this.call = deps.call || null;
    this.modules = deps.modules || (() => []);
    this.log = deps.log || (() => {});
    /** Sources synced since start; one not yet synced is synced before anything is read. */
    this.synced = new Set();
    /** Resyncs run one at a time, in order; readers wait for the queue. @type {Promise<any>} */
    this.chain = Promise.resolve();
  }

  // ---- synced sources: vault, google, mcp ----------------------------------------------

  /**
   * Queue a resync. Google and mcp go first: an item one of their rows signs in with is that
   * row, not a second vault row. Errors are logged; the queue keeps going.
   * @param {string[]} [sources]
   */
  resync(sources = SYNCED) {
    const want = SYNCED.filter(s => sources.includes(s));
    const run = this.chain.then(async () => {
      /** @type {Record<string, any>} */
      const out = {};
      for (const s of want) {
        const r = s === "vault" ? await this.syncVault() : s === "google" ? await this.syncGoogle() : await this.syncMcp();
        if (r) out[s] = r;
      }
      return out;
    });
    this.chain = run.catch(e => this.log(`vault connections: resync failed: ${/** @type {Error} */ (e).message}`));
    return run;
  }

  /** Wait for queued resyncs, and sync what has not been since start. */
  async ready() {
    const missing = SYNCED.filter(s => !this.synced.has(s));
    if (missing.length) await this.resync(missing).catch(() => {});
    await this.chain;
  }

  /** A read-only tool's list, [] for a module that is not running, or null for any other error. */
  async ask(tool) {
    if (!this.call) return [];
    let r;
    try { r = await this.call(tool, {}); } catch (e) { r = { error: { code: "failed", message: /** @type {Error} */ (e).message } }; }
    if (r && r.error) {
      if (r.error.code === "no_such_tool") return [];
      this.log(`vault connections: ${tool} answered ${r.error.code || "an error"}: ${cut(r.error.message, 200)}`);
      return null;
    }
    return Array.isArray(r && r.data) ? r.data : [];
  }

  /** Each google.accounts row is one connection: ref the account name, account its email. */
  async syncGoogle() {
    const rows = await this.ask("google.accounts");
    if (rows === null) return null; // the source answered with an error: keep its rows
    await this.v.key();
    const found = rows.filter(a => a && typeof a.name === "string" && REF.test(a.name)).map(a => {
      const sa = a.auth && a.auth.type === "service-account";
      const capabilities = googleCapabilities(a);
      return { ref: a.name, provider: sa ? "google-dwd" : "google-oauth", account: cut(a.email || a.name, 200), auth: sa ? "service-account" : "oauth",
        label: cut(a.email || a.name, 200), capabilities: capabilities.length ? capabilities : ["other"],
        items: a.auth && typeof a.auth.item === "string" && ITEM.test(a.auth.item) ? [a.auth.item] : [],
        use: capabilities.includes("calendar") ? { calendar: { tool: "google.calendar.list", input: { account: a.name } } } : null };
    });
    const out = this.apply("google", found, { removeMissing: true });
    this.synced.add("google");
    return out;
  }

  /** Each mcp.servers row is one connection: ref the server name, capabilities from its cached tools. */
  async syncMcp() {
    const servers = await this.ask("mcp.servers");
    if (servers === null) return null;
    const tools = servers.length ? await this.ask("mcp.tools") : [];
    if (tools === null) return null;
    await this.v.key();
    /** @type {Map<string, string[]>} */
    const by = new Map();
    for (const t of tools) if (t && typeof t.server === "string") by.set(t.server, [...(by.get(t.server) || []), String(t.tool || t.name)]);
    const found = servers.filter(x => x && typeof x.name === "string" && REF.test(x.name)).map(x => {
      const caps = toolCapabilities(by.get(x.name) || [], x.name);
      const list = CAPABILITIES.filter(c => c in caps);
      /** @type {Record<string, any>} */
      const use = {};
      // Mail goes through the mail module by connection id; everything else calls the server.
      for (const c of list) if (!(c in MAIL_USE)) use[c] = { tool: "mcp.call", input: { server: x.name, tool: caps[c] } };
      const auth = { bearer: "bearer", oauth: "oauth", "service-account": "service-account", env: "api-key" }[String(x.auth && x.auth.type)] || "none";
      return { ref: x.name, provider: "mcp", account: cut(x.label || x.name, 200), auth, label: cut(x.label || x.name, 200),
        capabilities: list.length ? list : ["other"], items: x.auth && typeof x.auth.item === "string" && ITEM.test(x.auth.item) ? [x.auth.item] : [],
        use: Object.keys(use).length ? use : null };
    });
    const out = this.apply("mcp", found, { removeMissing: true });
    this.synced.add("mcp");
    return out;
  }

  async syncVault() {
    await this.v.key();
    // An item a module's registered row signs in with is that row, not a second connection.
    const claimed = new Set(/** @type {any[]} */ (this.db.prepare("SELECT items FROM vault_connections WHERE source != 'vault'").all()).flatMap(r => json(r.items, [])));
    const found = this.v.list().items
      .filter(i => i.details && typeof i.details.provider === "string" && catalog(i.details.provider) && !i.name.includes("/") && !claimed.has(i.name))
      .map(i => {
        const p = /** @type {import("./providers.js").Provider} */ (catalog(i.details.provider));
        return { ref: i.name, provider: p.name, account: i.name, auth: AUTH_OF_KIND[/** @type {keyof typeof AUTH_OF_KIND} */ (i.kind)] || "api-key",
          label: cut(i.description || i.name, 200), capabilities: [...p.capabilities], items: [i.name], use: null };
      });
    const out = this.apply("vault", found, { removeMissing: true });
    this.synced.add("vault");
    return out;
  }

  /**
   * Upsert rows of one source; with removeMissing, rows the source no longer has go. A person's
   * edits are kept. A row a module registered is its own: a sync neither changes nor removes it.
   * Returns counts and the ids of the rows found.
   * @param {string} source @param {any[]} found @param {{ removeMissing?: boolean, registered?: boolean }} [o]
   */
  apply(source, found, { removeMissing = false, registered = false } = {}) {
    const t = Date.now();
    const old = new Map(/** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_connections WHERE source = ?").all(source)).map(r => [r.ref, r]));
    let added = 0, changed = 0, removed = 0;
    /** @type {string[]} */ const ids = [];
    /** @type {[string, any][]} */ const events = [];
    this.v.tx(() => {
      for (const f of found) {
        const r = old.get(f.ref);
        old.delete(f.ref);
        const use = f.use ? JSON.stringify(f.use) : null;
        if (r && !registered && json(r.edited, []).includes("registered")) { ids.push(r.id); continue; }
        if (!r) {
          const id = newId();
          this.db.prepare(`INSERT INTO vault_connections (id, source, ref, provider, account, auth, label, capabilities, surfaces, added, updated, items, use, edited)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, source, f.ref, f.provider, f.account, f.auth, f.label, JSON.stringify(f.capabilities),
            JSON.stringify(DEFAULT_SURFACES), t, t, JSON.stringify(f.items || []), use, JSON.stringify(registered ? ["registered"] : []));
          this.v.sign("vault_connections", id);
          ids.push(id);
          events.push(["vault.connection-added", { id, source, provider: f.provider, account: f.account }]);
          added++;
          continue;
        }
        ids.push(r.id);
        const good = this.v.rowOk("vault_connections", r);
        const edited = json(r.edited, []);
        const next = {
          provider: f.provider, account: f.account, auth: f.auth,
          label: edited.includes("label") ? r.label : f.label,
          capabilities: JSON.stringify(good && edited.includes("capabilities") ? json(r.capabilities, []) : f.capabilities),
          // A row someone else wrote is granted to nothing, and signed as that.
          surfaces: good ? r.surfaces : "[]",
          items: JSON.stringify(f.items || []), use,
          edited: JSON.stringify(registered && !edited.includes("registered") ? [...edited, "registered"] : edited),
        };
        const fields = Object.keys(next).filter(k => (r[k] ?? null) !== next[k]);
        if (good && !fields.length) continue;
        this.db.prepare("UPDATE vault_connections SET provider=?, account=?, auth=?, label=?, capabilities=?, surfaces=?, items=?, use=?, edited=?, updated=? WHERE id=?")
          .run(next.provider, next.account, next.auth, next.label, next.capabilities, next.surfaces, next.items, next.use, next.edited, t, r.id);
        this.v.sign("vault_connections", r.id);
        if (!good) this.v.audit("connection-reset", null, "vault", false, `connection ${r.id} failed its check; it is granted to no surface until a person grants it again`);
        const shown = fields.filter(k => k !== "edited");
        if (shown.length || !good) events.push(["vault.connection-changed", { id: r.id, fields: good ? shown : [...new Set([...shown, "surfaces"])] }]);
        changed++;
      }
      if (removeMissing) for (const r of old.values()) {
        if (json(r.edited, []).includes("registered")) continue;
        this.db.prepare("DELETE FROM vault_connections WHERE id = ?").run(r.id);
        events.push(["vault.connection-removed", { id: r.id }]);
        removed++;
      }
    });
    for (const [type, payload] of events) this.v.emit(type, payload);
    return { added, changed, removed, ids };
  }

  // ---- registered sources --------------------------------------------------------------

  /**
   * A module registers (or refreshes) one of its connections. The source is the module's name.
   * @param {any} input @param {string} caller
   */
  async register(input, caller) {
    const source = moduleOf(caller);
    const { ref, provider, account, auth, label, capabilities, tools, items, use } = input || {};
    if (!REF.test(String(ref ?? ""))) throw fail("ref must be the module's own name for this connection: letters, digits and . _ : @ + -, at most 200");
    if (typeof provider !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(provider)) throw fail("provider must be a lowercase name, such as google-dwd or mcp");
    if (typeof account !== "string" || !account.trim() || account.length > 200) throw fail("account must be text: the address or name a person knows it by");
    if (!AUTHS.includes(auth)) throw fail(`auth must be one of ${AUTHS.join(", ")}`);
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200)) throw fail("label must be text, 1 to 200 characters");
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some(c => !CAPABILITIES.includes(c)))) throw fail(`capabilities must be a list of ${CAPABILITIES.join(", ")}`);
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 500 || tools.some(t => typeof t !== "string" || t.length > 200))) throw fail("tools must be a list of tool names");
    if (items !== undefined && (!Array.isArray(items) || items.length > 20 || items.some(i => !ITEM.test(String(i))))) throw fail("items must be a list of vault item names");
    const uses = checkUse(use);
    const caps = capabilities !== undefined ? CAPABILITIES.filter(c => capabilities.includes(c))
      : tools !== undefined ? CAPABILITIES.filter(c => c in toolCapabilities(tools, `${ref} ${account}`)) : [];
    await this.v.key();
    const { ids } = this.apply(source, [{ ref: String(ref), provider, account: account.trim(), auth, label: cut((label || account).trim(), 200),
      capabilities: caps.length ? caps : ["other"], items: items ? items.map(String) : [], use: uses }], { registered: true });
    if (items && items.length) await this.resync(["vault"]).catch(() => {});
    return { id: ids[0], source, capabilities: caps.length ? caps : ["other"] };
  }

  /** @param {{ ref: string }} input @param {string} caller */
  async unregister({ ref }, caller) {
    const source = moduleOf(caller);
    const r = /** @type {any} */ (this.db.prepare("SELECT id FROM vault_connections WHERE source = ? AND ref = ?").get(source, String(ref ?? "")));
    if (!r) return { removed: false };
    this.db.prepare("DELETE FROM vault_connections WHERE id = ?").run(r.id);
    this.v.emit("vault.connection-removed", { id: r.id });
    await this.resync().catch(() => {});
    return { removed: true, id: r.id };
  }

  // ---- state ----------------------------------------------------------------------------

  /**
   * A row's state: ready, or needs_credential when one of its items is missing or not granted to
   * its source module, with the needs (from the module's manifest) that would fill it.
   * @param {any} r @param {Map<string, any>} byName vault.list's items
   */
  stateOf(r, byName) {
    const items = json(r.items, []);
    if (r.source === "vault") return { state: byName.has(r.ref) ? "ready" : "needs_credential", needs: [] };
    const bad = items.filter(i => { const it = byName.get(i); return !it || !(it.grants || []).some(g => g.module === r.source && !g.watcher); });
    if (!bad.length) return { state: "ready", needs: [] };
    const m = this.modules().find(x => x && x.name === r.source);
    const creds = m && Array.isArray(m.credentials) ? m.credentials : [];
    const needs = [];
    for (const item of bad) {
      const c = creds.find(x => (x.item || `${r.source}-${x.id}`) === item)
        || creds.find(x => x.multiple && item.startsWith(`${r.source}-`) && (!byName.get(item) || byName.get(item).details?.provider === x.provider));
      if (c && !needs.some(n => n.need === c.id)) needs.push({ module: r.source, need: c.id });
    }
    return { state: "needs_credential", needs };
  }

  // ---- reads ----------------------------------------------------------------------------

  items() { return new Map(this.v.list().items.map(i => [i.name, i])); }

  /** One row as a listing shows it. `full` is for a person: surfaces, tamper flag. */
  out(r, ok, full, byName) {
    const capabilities = json(r.capabilities, []);
    const uses = usesOf(r, capabilities, json(r.use, null));
    const { state, needs } = this.stateOf(r, byName);
    return { id: r.id, source: r.source, ref: r.ref, provider: r.provider, account: r.account, auth: r.auth, label: r.label, capabilities,
      state, ...(needs.length ? { needs } : {}),
      ...(full ? { surfaces: ok ? json(r.surfaces, []) : [], ...(ok ? {} : { tampered: true }) } : {}), uses, added: r.added, updated: r.updated };
  }

  /**
   * The surface a caller is, with an mcp:thread looked up through threads.get: a thread whose
   * purpose is "capsule" was started by the Capsule.
   * @param {string} caller
   */
  async surface(caller) {
    const s = surfaceOf(caller);
    if (s.thread && this.call) {
      try {
        const t = await this.call("threads.get", { thread: s.thread, limit: 1 });
        if (t && t.data && t.data.thread && t.data.thread.purpose === "capsule") return "capsule";
      } catch { /* no switchboard: chat */ }
    }
    return s.surface;
  }

  /**
   * Whose eyes a read uses: a person may look through any surface's (or all, with none), a
   * module must name one, anyone else sees only their own.
   * @param {string|undefined} surface @param {string} caller
   */
  async eyes(surface, caller, as) {
    if (as !== undefined && surfaceOf(caller).surface === "module") {
      if (surface !== undefined) throw fail("pass surface or caller, not both");
      const s = await this.surface(String(as));
      if (s === "person") return { person: true, eyes: null };
      if (s === "module" || !s) throw fail(`${cut(as, 64)} is no surface a connection can be granted to`, "denied");
      return { person: false, eyes: s };
    }
    if (surface !== undefined && !SURFACE_NAMES.includes(/** @type {any} */ (surface))) throw fail(`surface must be one of ${SURFACE_NAMES.join(", ")}`);
    const own = await this.surface(caller);
    if (own === "person") return { person: true, eyes: surface || null };
    if (own === "module") {
      if (!surface) throw fail("a module lists for a surface: pass surface (capsule, chat, agents or phone) or caller, the one it acts for");
      return { person: false, eyes: surface };
    }
    if (!own) throw fail("this caller is no surface a connection can be granted to", "denied");
    if (surface !== undefined && surface !== own) throw fail(`this caller is the ${own} surface; it cannot list for ${surface}`, "denied");
    return { person: false, eyes: own };
  }

  /**
   * The rows a surface may use, each with `uses` (capability -> {tool, input}), and `use`, the
   * entry for the capability asked, when one is.
   * @param {{ capability?: string, surface?: string, caller?: string }} input @param {string} caller
   */
  async list({ capability, surface, caller: as } = {}, caller) {
    if (capability !== undefined && !CAPABILITIES.includes(/** @type {any} */ (capability))) throw fail(`capability must be one of ${CAPABILITIES.join(", ")}`);
    const { person, eyes } = await this.eyes(surface, caller, as);
    await this.ready();
    const byName = this.items();
    const out = [];
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_connections ORDER BY source, account, ref").all())) {
      const ok = this.v.rowOk("vault_connections", r);
      if (eyes && !(ok && json(r.surfaces, []).includes(eyes))) continue;
      const row = this.out(r, ok, person, byName);
      if (capability && !row.capabilities.includes(capability)) continue;
      out.push(capability ? { ...row, use: row.uses[capability] || null } : row);
    }
    return { surface: eyes || "person", connections: out };
  }

  /** One row, as list shows it, for a caller whose surface may use it. @param {{ id: string }} input @param {string} caller */
  async get({ id }, caller) {
    const { person, eyes } = await this.eyes(undefined, caller).catch(e => { if (surfaceOf(caller).surface === "module") return { person: true, eyes: null }; throw e; });
    await this.ready();
    const r = this.must(id);
    const ok = this.v.rowOk("vault_connections", r);
    if (eyes && !(ok && json(r.surfaces, []).includes(eyes))) throw fail(`no connection ${cut(id, 40)} for this surface`, "not_found");
    return { connection: this.out(r, ok, person, this.items()) };
  }

  must(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_connections WHERE id = ?").get(String(id ?? "")));
    if (!r) throw fail(`no connection ${cut(id, 40)}; vault.connections.list shows them`, "not_found");
    return r;
  }

  checkSurface(surface) {
    if (!SURFACE_NAMES.includes(/** @type {any} */ (surface))) throw fail(`surface must be one of ${SURFACE_NAMES.join(", ")}`);
  }

  /** The words a person reads before granting or editing. @param {{ id: string, surface?: string }} input */
  summary({ id, surface }) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_connections WHERE id = ?").get(String(id ?? "")));
    if (!r) return "";
    const what = `${cut(r.label, 80)} (${cut(r.provider, 40)}, ${cut(r.account, 120)})`;
    if (!surface) return `Change ${what}`;
    const who = { capsule: "the Capsule", chat: "Claude in chat threads", agents: "your agents", phone: "your phone" }[String(surface)] || cut(surface, 20);
    return `Let ${who} use ${what}`;
  }

  async setSurfaces(id, fn, caller, action) {
    await this.ready();
    const r = this.must(id);
    const ok = this.v.rowOk("vault_connections", r);
    const before = ok ? json(r.surfaces, []) : [];
    const next = SURFACE_NAMES.filter(s => fn(before).includes(s));
    await this.v.key();
    this.db.prepare("UPDATE vault_connections SET surfaces=?, updated=? WHERE id=?").run(JSON.stringify(next), Date.now(), r.id);
    this.v.sign("vault_connections", r.id);
    this.v.audit(action, null, caller, true, `connection ${r.id} (${r.source}:${cut(r.ref, 64)}): ${next.join(", ") || "no surface"}`);
    if (!ok || JSON.stringify(before) !== JSON.stringify(next)) this.v.emit("vault.connection-changed", { id: r.id, fields: ["surfaces"] });
    return { connection: this.out(this.must(id), true, true, this.items()) };
  }

  /** @param {{ id: string, surface: string }} input @param {string} caller */
  grant({ id, surface }, caller) {
    this.checkSurface(surface);
    return this.setSurfaces(id, s => [...s, surface], caller, "connection-grant");
  }

  /** @param {{ id: string, surface: string }} input @param {string} caller */
  revoke({ id, surface }, caller) {
    this.checkSurface(surface);
    return this.setSurfaces(id, s => s.filter(x => x !== surface), caller, "connection-revoke");
  }

  /** @param {{ id: string, label?: string, capabilities?: string[] }} input @param {string} caller */
  async update({ id, label, capabilities }, caller) {
    await this.ready();
    const r = this.must(id);
    await this.v.key();
    if (!this.v.rowOk("vault_connections", r)) throw fail(`connection ${r.id} failed its check; resync it (vault.connections.sync) and grant it again`, "tampered");
    const edited = new Set(json(r.edited, []));
    let l = r.label, caps = json(r.capabilities, []);
    const fields = [];
    if (label !== undefined) {
      if (typeof label !== "string" || !label.trim() || label.length > 200) throw fail("label must be text, 1 to 200 characters");
      l = label.trim(); edited.add("label"); fields.push("label");
    }
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities) || capabilities.some(c => !CAPABILITIES.includes(c))) throw fail(`capabilities must be a list of ${CAPABILITIES.join(", ")}`);
      caps = CAPABILITIES.filter(c => capabilities.includes(c)); edited.add("capabilities"); fields.push("capabilities");
    }
    if (!fields.length) throw fail("say what to change: label or capabilities");
    this.db.prepare("UPDATE vault_connections SET label=?, capabilities=?, edited=?, updated=? WHERE id=?").run(l, JSON.stringify(caps), JSON.stringify([...edited]), Date.now(), r.id);
    this.v.sign("vault_connections", r.id);
    this.v.audit("connection-update", null, caller, true, `connection ${r.id}: ${fields.join(", ")}`);
    this.v.emit("vault.connection-changed", { id: r.id, fields });
    return { connection: this.out(this.must(id), true, true, this.items()) };
  }

  /**
   * May this caller use this connection? People always may. Anyone else needs a row, whose MAC
   * holds, granted to their surface. A module acting as itself (caller module:<name>) is not a
   * surface: it must pass the caller it acts for.
   * @param {{ id?: string, source?: string, ref?: string, caller: string }} input
   */
  async allowed({ id, source, ref, caller }) {
    const own = await this.surface(caller);
    if (own === "person") return { allowed: true, surface: "person" };
    if (own === "module") return { allowed: false, surface: null, reason: "pass the caller the module acts for, not a module" };
    if (!own) return { allowed: false, surface: null, reason: "this caller is no surface a connection can be granted to" };
    await this.ready();
    const r = /** @type {any} */ (id !== undefined
      ? this.db.prepare("SELECT * FROM vault_connections WHERE id = ?").get(String(id))
      : this.db.prepare("SELECT * FROM vault_connections WHERE source = ? AND ref = ?").get(String(source ?? ""), String(ref ?? "")));
    if (!r) return { allowed: false, surface: own, reason: "no such connection" };
    await this.v.key();
    if (!this.v.rowOk("vault_connections", r)) return { allowed: false, surface: own, reason: "the connection failed its check; a person must grant it again" };
    if (!json(r.surfaces, []).includes(own)) return { allowed: false, surface: own, reason: `${cut(r.label, 80)} is not granted to ${own}; grant it in Vault, Connections` };
    return { allowed: true, surface: own };
  }
}

/** The module a module caller is: "module:mail" is mail. @param {string} caller */
export function moduleOf(caller) {
  const m = /^module:([a-z][a-z0-9-]{0,40})$/.exec(String(caller ?? ""));
  if (!m) throw fail("only a module registers connections, and only its own", "denied");
  if (m[1] === "vault") throw fail("the vault keeps its own rows; it does not register them", "denied");
  return m[1];
}
