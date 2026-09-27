// @ts-check
// accounts: the mail accounts this vyred knows, one row each in mail_accounts (ADR 0016 decision 8).
//
// A row says which adapter serves the account, the address it sends from, which surfaces may use
// it, and the adapter's settings. Like every connector table it holds vault item names, never a
// value: a password, a token or an Apps Script URL stays in the vault and is fetched per call.
//
// Surfaces, and why they are checked here and not left to each adapter:
// - The surface comes from the caller vyred verified, never from the input: the Capsule is
//   `capsule`, a person's own Claude session is `mcp` (chat), an agent is `mcp:agent:<name>`.
// - People's managing callers (cli, deck, local) see every account, to manage them.
// - An account a surface may not use is invisible to it. A refusal that named it would tell a
//   model the account exists.

import { EMAIL } from "../connectors/message.js";

export const MIGRATIONS = [
  `CREATE TABLE mail_accounts (
     account TEXT PRIMARY KEY, adapter TEXT NOT NULL, address TEXT NOT NULL, label TEXT,
     surfaces TEXT NOT NULL, config TEXT NOT NULL, added INTEGER NOT NULL, updated INTEGER NOT NULL
   );`,
];

export const ADAPTERS = ["google-dwd", "google-oauth", "mcp", "apps-script", "imap"];
export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_SURFACES = Object.freeze({ capsule: true, chat: true, agents: [] });

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const json = (s, d) => { try { return JSON.parse(String(s)); } catch { return d; } };

/**
 * Surfaces from an input, checked: `{ capsule?: bool, chat?: bool, agents?: "*" | [names] }`.
 * @param {any} v @param {any} [base]
 */
export function surfacesOf(v, base = DEFAULT_SURFACES) {
  if (v === undefined) return { ...base, agents: Array.isArray(base.agents) ? [...base.agents] : base.agents };
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail("surfaces must be { capsule, chat, agents }");
  const out = { capsule: base.capsule, chat: base.chat, agents: base.agents };
  for (const k of Object.keys(v)) if (!["capsule", "chat", "agents"].includes(k)) throw fail(`surfaces has no ${k}; it takes capsule, chat and agents`);
  if (v.capsule !== undefined) { if (typeof v.capsule !== "boolean") throw fail("surfaces.capsule must be true or false"); out.capsule = v.capsule; }
  if (v.chat !== undefined) { if (typeof v.chat !== "boolean") throw fail("surfaces.chat must be true or false"); out.chat = v.chat; }
  if (v.agents !== undefined) {
    if (v.agents !== "*" && !(Array.isArray(v.agents) && v.agents.every(a => AGENT.test(String(a))))) throw fail("surfaces.agents must be \"*\" or a list of agent names");
    out.agents = v.agents === "*" ? "*" : [...new Set(v.agents.map(String))];
  }
  return out;
}

/**
 * Who is calling, as a surface: from the caller vyred verified and the meta it gave.
 * `module` callers name the surface they act for in `on_behalf.surface` (a module is trusted
 * code; mail itself never acts for one on its own).
 * @param {string} caller @param {any} meta @param {any} [behalf]
 * @returns {{ kind: "person" } | { kind: "capsule" } | { kind: "chat", thread?: string } | { kind: "agent", agent: string, thread?: string }}
 */
export function surfaceOf(caller, meta = {}, behalf) {
  const c = String(caller || "");
  const agentFrom = /^mcp:agent:(.+)$/.exec(c);
  if (agentFrom || meta.agent) return { kind: "agent", agent: String(meta.agent || agentFrom?.[1]), ...(meta.thread ? { thread: meta.thread } : {}) };
  if (c === "mcp") return { kind: "chat", ...(meta.thread ? { thread: meta.thread } : {}) };
  if (c === "capsule") return { kind: "capsule" };
  if (c.startsWith("module:")) {
    const b = behalf && typeof behalf === "object" ? behalf : {};
    if (b.surface === "capsule") return { kind: "capsule" };
    if (b.surface === "agent" && typeof b.agent === "string" && b.agent) return { kind: "agent", agent: b.agent, ...(b.thread ? { thread: String(b.thread) } : {}) };
    if (b.surface === "chat") return { kind: "chat", ...(b.thread ? { thread: String(b.thread) } : {}) };
    return { kind: "person" };
  }
  if (["cli", "local", "deck"].includes(c)) return { kind: "person" };
  // Anything else (a tailnet guest, an unknown label) is treated as the narrowest surface there is.
  return { kind: "agent", agent: "" };
}

/** May this surface use this account? @param {any} acct @param {ReturnType<typeof surfaceOf>} s */
export function allowed(acct, s) {
  const sf = acct.surfaces;
  if (s.kind === "person") return true;
  if (s.kind === "capsule") return sf.capsule === true;
  if (s.kind === "chat") return sf.chat === true;
  if (!s.agent) return false;
  return sf.agents === "*" || (Array.isArray(sf.agents) && sf.agents.includes(s.agent));
}

const hostOk = h => typeof h === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(h) || h === "::1";

/**
 * The adapter settings of a new or changed account, checked. Returns the config to store.
 * Native adapters (imap, apps-script) are checked again by their own `check`.
 * @param {string} adapter @param {any} input
 */
export function configOf(adapter, input) {
  const item = (v, what) => { if (!ITEM.test(String(v || ""))) throw fail(`${what} must name a vault item`); return String(v); };
  if (adapter === "google-dwd" || adapter === "google-oauth") {
    if (!NAME.test(String(input.google || ""))) throw fail("google must name an account from google.accounts");
    return { google: String(input.google) };
  }
  if (adapter === "mcp") {
    if (!NAME.test(String(input.server || ""))) throw fail("server must name an MCP server from mcp.servers");
    const out = { server: String(input.server) };
    if (input.map !== undefined) out.map = input.map;
    return out;
  }
  if (adapter === "apps-script") {
    const a = input.auth || {};
    return { auth: { item: item(a.item, "auth.item") } };
  }
  if (adapter === "imap") {
    const a = input.auth || {};
    const side = (v, what) => {
      if (!v || typeof v !== "object" || !hostOk(v.host)) throw fail(`${what}.host must be a host name`);
      const o = { host: String(v.host) };
      if (v.port !== undefined) { if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) throw fail(`${what}.port must be a port number`); o.port = v.port; }
      if (v.tls !== undefined) o.tls = String(v.tls);
      return o;
    };
    const out = { imap: side(input.imap, "imap"), smtp: side(input.smtp, "smtp"), auth: { item: item(a.item, "auth.item"), ...(a.field ? { field: String(a.field) } : {}) } };
    if (input.username !== undefined) out.username = String(input.username);
    return out;
  }
  throw fail(`adapter must be one of ${ADAPTERS.join(", ")}`);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function store(db) {
  const row = r => r && ({
    account: String(r.account), adapter: String(r.adapter), address: String(r.address),
    ...(r.label ? { label: String(r.label) } : {}),
    surfaces: json(r.surfaces, DEFAULT_SURFACES), config: json(r.config, {}), added: Number(r.added), updated: Number(r.updated),
  });
  return {
    all: () => db.prepare("SELECT * FROM mail_accounts ORDER BY added, account").all().map(row),
    get: name => row(db.prepare("SELECT * FROM mail_accounts WHERE account = ?").get(String(name))),
    /** @param {{ account: string, adapter: string, address: string, label?: string, surfaces: any, config: any }} a @param {number} now */
    put(a, now) {
      if (!NAME.test(a.account)) throw fail("account must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (!ADAPTERS.includes(a.adapter)) throw fail(`adapter must be one of ${ADAPTERS.join(", ")}`);
      if (!EMAIL.test(a.address)) throw fail("address must be the address mail is sent from");
      db.prepare(`INSERT INTO mail_accounts (account, adapter, address, label, surfaces, config, added, updated) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account) DO UPDATE SET adapter = excluded.adapter, address = excluded.address, label = excluded.label,
        surfaces = excluded.surfaces, config = excluded.config, updated = excluded.updated`)
        .run(a.account, a.adapter, a.address, a.label || null, JSON.stringify(a.surfaces), JSON.stringify(a.config), now, now);
      return this.get(a.account);
    },
    remove: name => Number(db.prepare("DELETE FROM mail_accounts WHERE account = ?").run(String(name)).changes) > 0,
  };
}

/**
 * The one account a send goes from: the one named, or the only one this surface may use. Two
 * and none named is a question, never a guess.
 * @param {any[]} usable @param {string} [name]
 */
export function pickForSend(usable, name) {
  if (name !== undefined) {
    const one = usable.find(a => a.account === name);
    if (!one) throw fail(`no mail account named ${String(name).slice(0, 40)} that this surface may use${usable.length ? `; the accounts are ${usable.map(a => a.account).join(", ")}` : ""}`, "no_account");
    return one;
  }
  if (!usable.length) throw fail("no mail account is connected for this surface · add one in Settings, Connections, or with `vyre connect add mail`", "no_account");
  if (usable.length > 1) throw Object.assign(fail(`say which account this goes from: ${usable.map(a => `${a.account} (${a.address})`).join(", ")}`, "ambiguous"),
    { detail: { accounts: usable.map(a => ({ account: a.account, address: a.address })) } });
  return usable[0];
}

/** An account as tools show it: never a value, and config only as item names and hosts. */
export function view(a) {
  return { account: a.account, adapter: a.adapter, address: a.address, ...(a.label ? { label: a.label } : {}), surfaces: a.surfaces, config: a.config };
}
