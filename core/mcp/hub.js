// @ts-check
// The MCP hub: many servers behind one entry (ADR 0016, decisions 2, 3 and 4).
//
// A person adds servers (stdio, streamable HTTP, legacy SSE). Each row names vault items, never
// values; the Credentials library turns them into a header per request or an env for one child,
// and remembers every value it touched so everything that leaves here is scrubbed of them.
//
// Design choices, and why:
// - Nothing starts at boot and mcp.tools never spawns. A start lists the server's tools and caches
//   them in the row, so a new session lists tools from the store. Twenty servers cost twenty rows.
// - One unref'd setTimeout per running server stops it after `idle` ms without a call. No polls.
// - A crash marks the server failed; the next call restarts it, three times in five minutes at
//   most, then it stays failed until mcp.restart. A server that dies in a loop cannot spin.
// - Scope uses only what vyred verified (the agent from its key, the thread from the session key,
//   the thread's project from the Switchboard), and mcp.call checks it again: a tool the model
//   saw listed is not proof it may call it.
// - Anything that is not plainly a read goes to the Gate. Unknown means outward. The person can
//   mark a tool read, write or off. Nothing reaches the server until the Gate calls release with
//   the approved arguments.
//
// This class has no ctx: its dependencies are injected (as core/gate/gate.js), so tests can drive
// it with fakes and a fake clock.

import crypto from "node:crypto";
import { McpError } from "./client.js";
import { isPerson, isOwnerDevice } from "../../lib/caller.js";

export const MIGRATIONS = [
  `CREATE TABLE mcp_servers (
     name TEXT PRIMARY KEY, transport TEXT NOT NULL, command TEXT, args TEXT, cwd TEXT, url TEXT,
     headers TEXT, env TEXT, vars TEXT, auth TEXT NOT NULL, scope TEXT NOT NULL, tools TEXT NOT NULL,
     idle INTEGER, tools_cache TEXT, cached_at INTEGER, last_used INTEGER,
     added INTEGER NOT NULL, updated INTEGER NOT NULL
   );`,
];

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** Vault item names, as core/vault/vault.js. */
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/**
 * The longest aggregated name. Claude Code names a tool mcp__<server>__<tool> and the API allows
 * 64 characters; under the plugin the prefix is "mcp__plugin_vyre_vyre__" (23), which leaves 41.
 */
export const MAX_NAME = 41;
export const DEFAULT_IDLE = 10 * 60_000;
export const RESTARTS = 3;
export const RESTART_WINDOW = 5 * 60_000;
/** A tool result a model reads is cut at this many characters of JSON. */
export const MAX_RESULT = 256 * 1024;
const STDERR_LINES = 20;

export const TRANSPORTS = ["stdio", "http", "sse"];
export const AUTH_TYPES = ["none", "bearer", "env", "oauth", "service-account"];
const MODES = ["read", "write", "off"];

// ---- classification (ADR 0016, decision 4) ----

const READ_VERBS = ["list", "get", "search", "read", "find", "fetch", "query", "describe", "lookup", "view", "show"];
/** Words that mean a tool sends, writes or deletes. Matching one is outward, whatever else it says. */
const WRITE_WORDS = ["send", "post", "reply", "forward", "publish", "share", "invite", "tweet", "dm", "comment", "notify",
  "create", "update", "write", "set", "put", "add", "edit", "modify", "patch", "insert", "upsert", "upload", "save", "submit", "rename",
  "move", "copy", "assign", "merge", "close", "reopen", "approve", "reject", "cancel", "run", "execute", "exec", "trigger",
  "deploy", "start", "stop", "restart", "import", "sync", "push", "commit", "grant", "revoke",
  "delete", "remove", "destroy", "drop", "erase", "purge", "trash", "archive", "unlink", "clear", "reset", "wipe",
  "pay", "payment", "charge", "transfer", "refund", "purchase", "buy", "checkout", "spend", "subscribe"];
/** Substrings strong enough to match inside an unsplit name ("sendmessage", "deleteall"). */
const WRITE_STEMS = ["send", "delete", "remove", "publish", "transfer", "destroy", "purge", "payment", "refund", "purchase", "upload", "forward", "reply"];
const DELETE_WORDS = ["delete", "remove", "destroy", "drop", "erase", "purge", "trash", "archive", "unlink", "wipe", "clear"];
const PAY_WORDS = ["pay", "payment", "charge", "transfer", "refund", "purchase", "buy", "order", "checkout", "spend", "invoice", "subscribe"];
/** Where an outward call is going: the first of these arguments, else the server's name. */
/**
 * Errors after which the call did not reach the server, or the server itself answered no: a
 * JSON-RPC refusal, a failed start, a lost session or login (the request was refused as a whole).
 * Anything else once the request was handed over (the server exited or closed mid-call, a
 * timeout, a network failure) may have reached it: `detail.reached` is "maybe".
 */
export const NOT_REACHED = new Set(["rpc", "spawn_failed", "unauthorized", "session_expired"]);

export const TO_KEYS = ["to", "channel", "channel_id", "conversation_id", "chat_id", "recipient", "email", "address", "url"];

/** A tool name as lowercase words: "sendMessage", "send_message" and "send-message" all read the same. */
export function words(name) {
  return String(name || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Words that mean a tool sends as the person. The floor's name rule (core/harness/rules.js rule 1)
 * asks about these and steps aside for hub tools only because the hub holds them, so a tool with
 * one is held whatever the person's mode says; it can be write or off, never read.
 */
const SEND_WORDS = ["send", "post", "reply", "forward", "publish", "share", "invite", "tweet", "dm", "comment"];
const SEND_STEMS = ["send", "reply", "forward", "publish"];
/** The name rule's own test, so a name it would ask about is always one this says sends. */
const SENDS = /(^|[_-])(send|post|reply|forward|publish|share|invite|tweet|dm|comment)([_-]|$)/i;

/** Whether a tool name sends as the person: a send word, a send stem inside it, or the name rule's match. */
export function sends(name) {
  const flat = String(name || "").toLowerCase();
  return words(name).some(w => SEND_WORDS.includes(w)) || SEND_STEMS.some(s => flat.includes(s)) || SENDS.test(String(name || ""));
}

/**
 * Read or outward, and the Gate kind for an outward one. A tool that sends is outward whatever
 * the mode or its annotations say, judged by its own name and by the aggregated name a model and
 * the floor see (a cut name can read differently).
 * @param {{ name: string, annotations?: any }} tool @param {string} [mode] the person's tools.mode for it
 * @param {string} [alias] the aggregated <server>__<tool> name, when known
 * @returns {{ outward: boolean, kind: "send"|"spend"|"delete", off: boolean }}
 */
export function classify(tool, mode, alias) {
  const ws = words(tool.name);
  const flat = String(tool.name || "").toLowerCase();
  // "Starts with" is for a name that is one unbroken word ("sendmessage", "listissues"); a name
  // with separators is read word by word, so "address_lookup" is not an "add".
  const one = ws.length === 1;
  const writes = ws.some(w => WRITE_WORDS.includes(w)) || (one && WRITE_WORDS.some(w => w.length > 2 && flat.startsWith(w))) || WRITE_STEMS.some(s => flat.includes(s));
  const reads = ws.some(w => READ_VERBS.includes(w)) || (one && READ_VERBS.some(v => flat.startsWith(v)));
  const hint = Boolean(tool.annotations && tool.annotations.readOnlyHint === true);
  const kind = ws.some(w => DELETE_WORDS.includes(w)) || /delete|remove|destroy|purge/.test(flat) ? "delete"
    : ws.some(w => PAY_WORDS.includes(w)) || /payment|refund|purchase|transfer/.test(flat) ? "spend" : "send";
  if (mode === "off") return { outward: true, kind, off: true };
  if (sends(tool.name) || (alias && sends(alias.slice(alias.indexOf("__") + 2)))) return { outward: true, kind, off: false };
  if (mode === "read") return { outward: false, kind, off: false };
  if (mode === "write") return { outward: true, kind, off: false };
  return { outward: !((reads || hint) && !writes), kind, off: false };
}

/** Where an outward call goes, and which argument said so. @param {any} args @param {string} server */
export function target(args, server) {
  for (const k of TO_KEYS) {
    const v = args && args[k];
    if (typeof v === "string" && v.trim()) return { key: k, to: [v.trim()], list: false };
    if (Array.isArray(v) && v.length && v.every(x => typeof x === "string" && x.trim())) return { key: k, to: v.map(x => x.trim()), list: true };
  }
  return { key: null, to: [server], list: false };
}

// ---- names ----

const hash6 = s => crypto.createHash("sha256").update(s).digest("hex").slice(0, 6);

/**
 * Aggregated names for one server's tools: <server>__<tool>, the tool reduced to [A-Za-z0-9_-],
 * cut to MAX_NAME with a hash of the real name when too long or when two tools reduce alike.
 * Deterministic for a given tool list.
 * @param {string} server @param {string[]} tools @returns {Map<string, string>} real tool name to aggregated
 */
export function aggregate(server, tools) {
  const out = new Map(), used = new Set();
  for (const t of [...new Set(tools)].sort()) {
    const reduced = t.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
    let name = `${server}__${reduced}`;
    if (name.length > MAX_NAME || used.has(name)) {
      const room = MAX_NAME - server.length - 2 - 7;
      const head = reduced.slice(0, Math.max(0, room));
      name = `${server}__${head ? head + "_" : "t"}${hash6(t)}`;
    }
    used.add(name);
    out.set(t, name);
  }
  return out;
}

// ---- validation ----

/** A value that reads like a credential: a known token prefix, a JWT, or a long unbroken run of mixed characters. */
export function looksSecret(v) {
  const s = String(v ?? "");
  if (/^(bearer|basic|token)\s+\S{8,}/i.test(s)) return true;
  if (/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|sk_live_|sk_test_|rk_live_|pk_live_|xox[abprs]-|xapp-|AKIA|ASIA|AIza|ya29\.|lin_api_|ntn_|secret_|shpat_|SG\.)/.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(s)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
  if (s.length >= 24 && !/[\s/\\]/.test(s) && /[a-z]/.test(s) && /[A-Z0-9]/.test(s) && /[0-9]/.test(s) && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return true;
  return false;
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|key|auth|password|passwd|session|signature/i;
const SENSITIVE_QUERY = /token|secret|key|auth|password|passwd|sig|session|code/i;
const bad = (msg) => Object.assign(new Error(msg), { code: "bad_input" });
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const strList = v => Array.isArray(v) && v.every(x => typeof x === "string" && x.length > 0 && x.length <= 200);

/**
 * Whether plain http may reach this host: loopback, or a tailnet address (100.64.0.0/10), or an
 * origin the person listed under mcp.httpHosts in config.json. Everything else needs https, since
 * a bearer header over plain http can be read on the way.
 * @param {URL} u @param {string[]} extra
 */
function httpAllowed(u, extra) {
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(h) || /^127\./.test(h)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  return extra.some(x => { try { return new URL(x).origin === u.origin; } catch { return false; } });
}

/** @param {any} url @param {string[]} httpHosts */
export function checkUrl(url, httpHosts = []) {
  let u;
  try { u = new URL(String(url)); } catch { throw bad("url is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("url must be http or https");
  if (u.protocol === "http:" && !httpAllowed(u, httpHosts)) throw bad(`plain http is allowed only to this machine or the tailnet (100.64.0.0/10); use https, or list ${u.origin} under mcp.httpHosts in config.json`);
  if (u.username || u.password) throw bad("url must not carry a user or password; put the credential in the vault and use auth");
  for (const [k, v] of u.searchParams) if (SENSITIVE_QUERY.test(k) || looksSecret(v)) throw bad(`url has a query parameter ${k.slice(0, 40)} that looks like a credential; put it in the vault and use auth`);
  if (u.hash) throw bad("url must not have a #fragment");
  return u.toString();
}

/** A vault reference: an item name, or { item, field }. @param {any} ref @param {string} where */
function checkRef(ref, where) {
  const r = typeof ref === "string" ? { item: ref } : ref;
  if (!isObj(r) || typeof r.item !== "string" || !ITEM.test(r.item)) throw bad(`${where} must name a vault item (or { item, field }), not a value`);
  if (looksSecret(r.item)) throw bad(`${where} looks like a secret value, not a vault item name; put it in the vault with vyre vault put and name the item here`);
  if (r.field !== undefined && (typeof r.field !== "string" || !r.field || r.field.length > 64)) throw bad(`${where}.field must be a field name`);
  return r.field ? { item: r.item, field: r.field } : r.item;
}

/**
 * Whether a stdio command runs Vyre's own MCP server: `vyre mcp` (the bin, or node running it) or
 * harness/mcp/server.js directly. As a hub server it would be vyred's child with no session, so an
 * agent's scope would be lost, and its tools are offered through the one vyre entry already.
 * @param {string} command @param {string[]} args
 */
function ownServer(command, args) {
  const parts = [command, ...args].map(a => String(a).replace(/\\/g, "/"));
  const base = a => a.split("/").pop() || "";
  if (parts.some(a => a.endsWith("harness/mcp/server.js"))) return true;
  return parts.some(a => ["vyre", "vyre.js", "vyre.mjs"].includes(base(a))) && args.includes("mcp");
}

/**
 * The stored row for an add or update, checked. Refuses anything that would put a value in the
 * table: a sensitive header, an env value that is not a vault item, a credential in a url.
 * @param {any} i @param {{ httpHosts?: string[] }} [opts]
 */
export function normalize(i, opts = {}) {
  if (!NAME.test(String(i.name || ""))) throw bad("a server name is a lowercase letter, then up to 31 lowercase letters, digits or dashes");
  if (!TRANSPORTS.includes(i.transport)) throw bad(`transport must be one of ${TRANSPORTS.join(", ")}`);
  const stdio = i.transport === "stdio";
  const out = { name: i.name, transport: i.transport, command: null, args: [], cwd: null, url: null, headers: {}, env: {}, vars: {} };
  if (stdio) {
    if (typeof i.command !== "string" || !i.command.trim()) throw bad("a stdio server needs a command");
    if (i.url) throw bad("a stdio server has a command, not a url");
    if (i.args !== undefined && !(Array.isArray(i.args) && i.args.every(a => typeof a === "string"))) throw bad("args must be a list of strings");
    for (const a of i.args || []) if (looksSecret(a)) throw bad("an argument looks like a secret; pass it through env from the vault instead");
    if (i.cwd != null && (typeof i.cwd !== "string" || !i.cwd)) throw bad("cwd must be a folder");
    if (ownServer(i.command, i.args || [])) throw bad("that is Vyre's own MCP server; its tools are already offered through the one vyre entry");
    Object.assign(out, { command: i.command, args: i.args || [], cwd: i.cwd || null });
    if (i.headers && Object.keys(i.headers).length) throw bad("headers are for http and sse servers");
  } else {
    if (i.command) throw bad(`an ${i.transport} server has a url, not a command`);
    out.url = checkUrl(i.url, opts.httpHosts);
    if (i.env && Object.keys(i.env).length || i.vars && Object.keys(i.vars).length) throw bad("env and vars are for stdio servers");
  }
  if (i.headers !== undefined) {
    if (!isObj(i.headers)) throw bad("headers must be an object of name: value");
    for (const [k, v] of Object.entries(i.headers)) {
      if (!HEADER_NAME.test(k)) throw bad(`${k.slice(0, 40)} is not a header name`);
      if (typeof v !== "string" || /[\r\n]/.test(v)) throw bad(`header ${k} must be one line of text`);
      if (SENSITIVE_HEADER.test(k) || looksSecret(v)) throw bad(`header ${k} looks like a credential; put it in the vault and use auth { type: "bearer", item, header: "${k.toLowerCase()}" }`);
      out.headers[k.toLowerCase()] = v;
    }
  }
  if (i.env !== undefined) {
    if (!isObj(i.env)) throw bad("env must be an object of VAR: vault item");
    for (const [k, v] of Object.entries(i.env)) { if (!ENV_NAME.test(k)) throw bad(`${k.slice(0, 40)} is not an env var name`); out.env[k] = checkRef(v, `env.${k}`); }
  }
  if (i.vars !== undefined) {
    if (!isObj(i.vars)) throw bad("vars must be an object of VAR: plain value");
    for (const [k, v] of Object.entries(i.vars)) {
      if (!ENV_NAME.test(k)) throw bad(`${k.slice(0, 40)} is not an env var name`);
      if (typeof v !== "string") throw bad(`vars.${k} must be a string`);
      if (looksSecret(v) || /token|secret|password|passwd|api_?key|private/i.test(k)) throw bad(`vars.${k} looks like a credential; put it in the vault and name it under env instead`);
      out.vars[k] = v;
    }
  }
  out.auth = normalizeAuth(i.auth, out);
  for (const k of [...Object.keys(out.env), ...Object.keys(out.vars)]) if (/^VYRE_/.test(k)) throw bad(`${k.slice(0, 40)}: VYRE_ settings belong to Vyre, not a server`);
  out.scope = normalizeScope(i.scope);
  out.tools = normalizePolicy(i.tools);
  if (i.idle !== undefined && i.idle !== null && !(Number.isInteger(i.idle) && i.idle >= 100 && i.idle <= 24 * 3600_000)) throw bad("idle is milliseconds, from 100 to a day");
  out.idle = i.idle ?? null;
  return out;
}

function normalizeAuth(a, out) {
  const stdio = out.transport === "stdio";
  const envRefs = Object.keys(out.env).length > 0;
  if (a === undefined || a === null) a = { type: envRefs ? "env" : "none" };
  if (!isObj(a) || !AUTH_TYPES.includes(a.type)) throw bad(`auth.type must be one of ${AUTH_TYPES.join(", ")}`);
  if (a.type === "none") { if (envRefs) throw bad("env names vault items, so auth is { type: \"env\" }"); return { type: "none" }; }
  if (a.type === "env") {
    if (!stdio) throw bad("env auth is for stdio servers; an http server takes bearer, oauth or service-account");
    if (a.item !== undefined) {
      if (!ENV_NAME.test(String(a.var || ""))) throw bad("auth { type: \"env\", item } needs var: the env var name to set");
      out.env[a.var] = checkRef(a.field ? { item: a.item, field: a.field } : a.item, "auth.item");
    }
    if (!Object.keys(out.env).length) throw bad("env auth needs env: { VAR: vault item }, or auth.item with auth.var");
    return { type: "env" };
  }
  if (stdio) throw bad(`${a.type} auth is for http and sse servers; a stdio server takes env`);
  if (typeof a.item !== "string" || !ITEM.test(a.item) || looksSecret(a.item)) throw bad("auth.item must name a vault item");
  const r = { type: a.type, item: a.item };
  if (a.field !== undefined) { if (typeof a.field !== "string" || !a.field) throw bad("auth.field must be a field name"); r.field = a.field; }
  if (a.type === "bearer") {
    if (a.header !== undefined) { if (!HEADER_NAME.test(String(a.header))) throw bad("auth.header is not a header name"); r.header = String(a.header).toLowerCase(); }
    if (a.format !== undefined) { if (typeof a.format !== "string" || !a.format.includes("{value}") || /[\r\n]/.test(a.format)) throw bad("auth.format needs {value}, as \"token {value}\""); r.format = a.format; }
  }
  if (a.type === "service-account" && a.subject !== undefined) { if (typeof a.subject !== "string" || !a.subject) throw bad("auth.subject is the user to act as"); r.subject = a.subject; }
  if (a.scopes !== undefined) { if (!strList(a.scopes)) throw bad("auth.scopes must be a list of scopes"); r.scopes = a.scopes; }
  return r;
}

function normalizeScope(s) {
  if (s === undefined || s === null) return { projects: "*", agents: "*" };
  if (!isObj(s)) throw bad("scope is { projects: \"*\" | [ids], agents: \"*\" | [names] }");
  const one = (v, what) => { if (v === undefined || v === "*") return "*"; if (!Array.isArray(v) || !v.every(x => typeof x === "string" && x)) throw bad(`scope.${what} must be "*" or a list`); return [...new Set(v)]; };
  return { projects: one(s.projects, "projects"), agents: one(s.agents, "agents") };
}

function normalizePolicy(t) {
  if (t === undefined || t === null) return {};
  if (!isObj(t)) throw bad("tools is { allow?: [], deny?: [], mode?: { tool: read | write | off } }");
  const out = {};
  if (t.allow !== undefined) { if (!Array.isArray(t.allow) || !t.allow.every(x => typeof x === "string")) throw bad("tools.allow must be a list of tool names"); out.allow = t.allow; }
  if (t.deny !== undefined) { if (!Array.isArray(t.deny) || !t.deny.every(x => typeof x === "string")) throw bad("tools.deny must be a list of tool names"); out.deny = t.deny; }
  if (t.mode !== undefined) {
    if (!isObj(t.mode) || !Object.values(t.mode).every(m => MODES.includes(/** @type {string} */ (m)))) throw bad("tools.mode maps a tool to read, write or off");
    for (const [k, m] of Object.entries(t.mode)) if (m === "read" && sends(k)) { const name = k.slice(0, 80); throw bad(`${name} sends as the person, so it is always held and cannot be read: set ${name} to write or off`); }
    out.mode = t.mode;
  }
  return out;
}

// ---- the hub ----

const json = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fail = (code, msg) => Object.assign(new Error(msg), { code });
// A module's own call (the kernel's own "module:<name>" label, ctx.call - never a caller-
// forgeable claim the way an agent's own caller string is) is scoped like the person too, same
// as always; this guards it against smuggling an agent: or thread: claim behind "module:" the
// same way the pre-swap inline check did (whoFrom's own audited "claimed" regex).
const MODULE_CLAIM = /(?:^|[\s:])(agent|thread):/;

/**
 * @typedef {{ person: boolean, agent: string|null, thread: string|null }} Who
 * @typedef {{ db: import("node:sqlite").DatabaseSync, creds: import("../../lib/connectors/auth.js").Credentials,
 *   connect: typeof import("./client.js").connect, emit: (type: string, payload: any, where?: any) => any,
 *   log?: (m: string) => void, now?: () => number,
 *   offer?: (server: string) => Promise<void>,
 *   request?: (input: any) => Promise<{ id: string, message: string }>,
 *   item?: (id: string) => Promise<any>,
 *   agentProjects?: (agent: string) => Promise<"*"|string[]>,
 *   threadProject?: (thread: string) => Promise<string|null>,
 *   idle?: number, httpHosts?: string[], maxResult?: number, timeout?: number }} HubDeps
 */

/** Who is calling, from the registry's caller and what vyred verified. @returns {Who} */
export function whoFrom(caller, meta = {}) {
  const c = String(caller || "");
  const named = /(?:^|[\s:])agent:(\S+)/.exec(c);
  // Cohesion's audit, 2026-09-28: this used to check PEOPLE.includes(kind) alone, which stripped
  // "agent:kit" off "cli:agent:kit" before the check, reading it as person AND agent at once.
  // inScope() below trusts who.person to skip every per-agent scope check outright, so that let
  // an agent whose caller string carried an owner-surface prefix (however it got there) reach
  // every connected server the true owner can, not just its own scope. Swapped onto lib/caller.js's
  // isPerson now that this branch can take the dependency (stage/0.1.1 fold, 2026-09-28) - it
  // refuses an agent's or a thread's own claim first (the reviewer's round-2 MEDIUM on 513f984d:
  // a space before "agent:", or a claim with no name after it, both used to slip past an anchored
  // regex; isPerson's AGENT_CLAIM already treats these, and a thread: claim, the same as core/
  // modules' own callerKind strip does) before checking the owner surfaces.
  //
  // NOT a plain swap to isPerson(c) alone: isPerson also admits an owner device (isOwnerDevice -
  // tailnet:<owner>, device:<id>), which the old inline check never did, and per ADR 0032 any
  // script on a paired phone or tailnet node is that owner device with no person session behind
  // it - admitting it here would skip inScope()'s per-agent check for every connected MCP server.
  // Excluded explicitly (reviewer's HOLD on f2df7888, lead's ruling 2026-09-28) to keep today's
  // behaviour exactly; admitting an owner device with a real passkey-backed person session is a
  // separate design for later, not 0.1.1.
  const person = (isPerson(c) && !isOwnerDevice(c)) || (c.startsWith("module:") && !MODULE_CLAIM.test(c));
  return { person, agent: meta.agent || (named ? named[1] : null), thread: meta.thread || null };
}

export class Hub {
  /** @param {HubDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.db = deps.db;
    this.creds = deps.creds;
    this.now = deps.now || Date.now;
    /** Live state per server name. @type {Map<string, any>} */
    this.live = new Map();
    this.stopping = false;
  }

  // ---- rows ----

  row(name) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(String(name || "")));
    if (!r) return null;
    return { name: r.name, transport: r.transport, command: r.command, args: json(r.args, []), cwd: r.cwd, url: r.url,
      headers: json(r.headers, {}), env: json(r.env, {}), vars: json(r.vars, {}), auth: json(r.auth, { type: "none" }),
      scope: json(r.scope, { projects: "*", agents: "*" }), tools: json(r.tools, {}), idle: r.idle,
      cache: json(r.tools_cache, null), cachedAt: r.cached_at, lastUsed: r.last_used, added: r.added, updated: r.updated };
  }

  rows() { return this.db.prepare("SELECT name FROM mcp_servers ORDER BY name").all().map(r => this.row(r.name)); }

  must(name) {
    const r = this.row(name);
    if (!r) throw fail("not_found", `no MCP server ${String(name).slice(0, 40)}`);
    return r;
  }

  state(name) {
    let s = this.live.get(name);
    if (!s) { s = { state: "stopped", client: null, starting: null, timer: null, inflight: 0, crashes: [], error: null }; this.live.set(name, s); }
    return s;
  }

  /** A server as mcp.servers shows it: never a value. People see how it is set up; a model sees less. */
  view(r, full = true) {
    const s = this.live.get(r.name);
    const base = { name: r.name, transport: r.transport, state: s ? s.state : "stopped", tools: r.cache ? this.visibleTools(r).length : null,
      ...(s && s.error ? { error: s.error } : {}), lastUsed: r.lastUsed || null,
      auth: { type: r.auth.type, ...(r.auth.item ? { item: r.auth.item } : {}) }, scope: r.scope };
    if (!full) return base;
    const origin = r.url ? (() => { const u = new URL(r.url); return u.origin + u.pathname; })() : null;
    return { ...base, ...(r.command ? { command: r.command, args: r.args, ...(r.cwd ? { cwd: r.cwd } : {}) } : {}), ...(origin ? { url: origin } : {}),
      headers: Object.keys(r.headers), env: r.env, vars: Object.keys(r.vars), policy: r.tools, idle: r.idle ?? this.deps.idle ?? DEFAULT_IDLE,
      cachedAt: r.cachedAt || null, added: r.added, updated: r.updated };
  }

  // ---- management ----

  async add(input) {
    const n = normalize(input, { httpHosts: this.deps.httpHosts });
    if (this.row(n.name)) throw fail("conflict", `there is already a server ${n.name}; mcp.update changes it`);
    const now = this.now();
    this.db.prepare(`INSERT INTO mcp_servers (name, transport, command, args, cwd, url, headers, env, vars, auth, scope, tools, idle, added, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.name, n.transport, n.command, JSON.stringify(n.args), n.cwd, n.url, JSON.stringify(n.headers),
      JSON.stringify(n.env), JSON.stringify(n.vars), JSON.stringify(n.auth), JSON.stringify(n.scope), JSON.stringify(n.tools), n.idle, now, now);
    await this.deps.offer?.(n.name);
    this.deps.emit("mcp.added", { name: n.name, transport: n.transport, auth: n.auth.type });
    // Fill the tool cache now, so the first session lists tools without a spawn. A server whose
    // vault grant does not exist yet fails here; that is expected (the CLI grants, then tests),
    // so it does not count against the restart budget and the add still stands.
    const test = await this.test(n.name, { quiet: true });
    return { ...this.view(this.must(n.name)), test };
  }

  async update(input) {
    const r = this.must(input.name);
    const merged = { ...r, ...input };
    if (input.transport && input.transport !== r.transport) {
      for (const k of ["command", "args", "cwd", "url", "headers", "env", "vars", "auth"]) if (input[k] === undefined) delete merged[k];
    }
    const n = normalize(merged, { httpHosts: this.deps.httpHosts });
    const how = ["transport", "command", "args", "cwd", "url", "headers", "env", "vars", "auth"];
    const changed = Object.keys(input).filter(k => k !== "name");
    const reconnect = how.some(k => JSON.stringify(n[k]) !== JSON.stringify(r[k]));
    this.db.prepare(`UPDATE mcp_servers SET transport = ?, command = ?, args = ?, cwd = ?, url = ?, headers = ?, env = ?, vars = ?, auth = ?, scope = ?,
      tools = ?, idle = ?, updated = ?${reconnect ? ", tools_cache = NULL, cached_at = NULL" : ""} WHERE name = ?`).run(n.transport, n.command, JSON.stringify(n.args), n.cwd, n.url,
      JSON.stringify(n.headers), JSON.stringify(n.env), JSON.stringify(n.vars), JSON.stringify(n.auth), JSON.stringify(n.scope), JSON.stringify(n.tools), n.idle, this.now(), n.name);
    // A new command, url or credential is a different connection: the running one stops, and the
    // old tool list is dropped, since it may not be the same server any more.
    if (reconnect) { await this.stopServer(n.name, "updated"); const s = this.state(n.name); s.crashes = []; s.error = null; s.state = "stopped"; }
    else { const s = this.live.get(n.name); if (s && s.client) this.arm(n.name); }
    this.deps.emit("mcp.updated", { name: n.name, fields: changed });
    return this.view(this.must(n.name));
  }

  async remove({ name }) {
    this.must(name);
    await this.stopServer(name, "removed");
    this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
    this.live.delete(name);
    this.deps.emit("mcp.removed", { name });
    return { removed: name };
  }

  /**
   * Start it (or use the running one), list its tools and cache them. A person asked, so the
   * restart budget does not stop a test, and a passing test clears it.
   * @param {string} name @param {{ quiet?: boolean }} [o]
   */
  async test(name, o = {}) {
    const r = this.must(name);
    const t0 = this.now();
    const s = this.state(name);
    try {
      let client = s.client;
      if (!client) client = await this.ensure(name, { budget: !o.quiet, force: true });
      else await this.refresh(r.name, await client.listTools());
      s.crashes = [];
      const tools = this.visibleTools(this.must(name)).map(t => ({ name: t.name, tool: t.tool, outward: t.outward }));
      const stderr = this.stderrOf(client);
      this.arm(name);
      return { ok: true, tools, ms: this.now() - t0, ...(stderr.length ? { stderr } : {}) };
    } catch (e) {
      const stderr = this.stderrOf(s.lastClient);
      if (o.quiet && s.state === "failed") { s.state = "stopped"; }
      return { ok: false, tools: [], ms: this.now() - t0, error: this.message(e), ...(stderr.length ? { stderr } : {}) };
    }
  }

  async restart({ name }) {
    this.must(name);
    await this.stopServer(name, "restart");
    const s = this.state(name);
    s.crashes = []; s.error = null; s.state = "stopped";
    try { await this.ensure(name, { force: true }); } catch {}
    return { state: s.state, ...(s.error ? { error: s.error } : {}) };
  }

  /** @param {Who} who */
  async servers(who) {
    const memo = {}, out = [];
    for (const r of this.rows()) if (await this.inScope(r, who, memo)) out.push(this.view(r, who.person));
    return out;
  }

  // ---- scope ----

  /**
   * Whether the verified caller may see and use this server.
   * @param {any} r @param {Who} who @param {{ agentProjects?: any, project?: any }} memo
   */
  async inScope(r, who, memo) {
    if (who.person) return true;
    const { projects, agents } = r.scope;
    if (who.agent) {
      if (agents !== "*" && !agents.includes(who.agent)) return false;
      if (projects === "*") return true;
      if (memo.agentProjects === undefined) memo.agentProjects = this.deps.agentProjects ? await this.deps.agentProjects(who.agent).catch(() => []) : [];
      const ap = memo.agentProjects;
      return ap === "*" || (Array.isArray(ap) && ap.some(p => projects.includes(p)));
    }
    if (projects === "*") return true;
    const project = await this.projectOf(who, memo);
    return Boolean(project && projects.includes(project));
  }

  async projectOf(who, memo) {
    if (memo.project === undefined) memo.project = who.thread && this.deps.threadProject ? await this.deps.threadProject(who.thread).catch(() => null) : null;
    return memo.project;
  }

  /** A server's cached tools after the person's policy, with names and classification. */
  visibleTools(r) {
    const cache = Array.isArray(r.cache) ? r.cache : [];
    const names = aggregate(r.name, cache.map(t => String(t.name)));
    const pol = r.tools || {};
    const out = [];
    for (const t of cache) {
      const tool = String(t.name);
      if (pol.allow && pol.allow.length && !pol.allow.includes(tool)) continue;
      if (pol.deny && pol.deny.includes(tool)) continue;
      const c = classify(t, pol.mode && pol.mode[tool], names.get(tool));
      if (c.off) continue;
      out.push({ name: /** @type {string} */ (names.get(tool)), server: r.name, tool, description: cut(String(t.description || ""), 2000),
        input: isObj(t.inputSchema) ? t.inputSchema : { type: "object" }, outward: c.outward, kind: c.kind, sends: sends(tool), annotations: t.annotations });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @param {Who} who */
  async tools(who) {
    const memo = {};
    const out = [];
    for (const r of this.rows()) {
      if (!r.cache || !(await this.inScope(r, who, memo))) continue;
      for (const t of this.visibleTools(r)) out.push({ name: t.name, server: t.server, tool: t.tool, description: t.description, input: t.input, outward: t.outward });
    }
    return out;
  }

  /** Find a tool on a server by its own name, its reduced name or its aggregated name. */
  findTool(r, tool) {
    const want = String(tool || "");
    return this.visibleTools(r).find(t => t.tool === want || t.name === want || t.name === `${r.name}__${want}`) || null;
  }

  // ---- calls ----

  /**
   * A model's (or anyone's) call. Scope is checked here, whatever was listed; a read runs, an
   * outward call is held at the Gate and nothing reaches the server. `hold` (module callers only,
   * checked in index.js) holds even a read, for a module such as mail whose call always acts as
   * the person outside, whatever the tool's name or mode says.
   * @param {{ server?: string, tool?: string, name?: string, arguments?: any, hold?: boolean }} input @param {Who} who
   */
  async call(input, who) {
    let server = input.server, tool = input.tool;
    if (!server && input.name) { const i = String(input.name).indexOf("__"); if (i > 0) { server = input.name.slice(0, i); tool = input.name; } }
    if (!server || !tool) throw fail("bad_input", "say which tool: { server, tool } or { name: \"<server>__<tool>\" }");
    const args = input.arguments ?? {};
    if (!isObj(args)) throw fail("bad_input", "arguments must be an object");
    const r = this.row(server);
    const memo = {};
    if (!r || !(await this.inScope(r, who, memo))) throw fail("denied", `no MCP server ${String(server).slice(0, 40)} that this ${who.agent ? `agent (${who.agent})` : "session"} may use`);
    let t = r.cache ? this.findTool(r, tool) : null;
    const names = r.cache ? aggregate(r.name, r.cache.map(x => String(x.name))) : new Map();
    const cached = [...names].some(([raw, agg]) => raw === tool || agg === tool || agg === `${r.name}__${tool}`);
    // A tool the cache knows but the person turned off is refused without a spawn; an unknown
    // one may be new, so the server is started to list again.
    if (!t && !cached) {
      // Never listed, or the tool is new: start it, which lists and caches, then look again.
      await this.ensure(r.name);
      t = this.findTool(this.must(r.name), tool);
    }
    if (!t) throw fail("not_found", `${r.name} has no tool ${String(tool).slice(0, 80)} that is on`);
    if (t.outward) return this.hold(r, t, args, who, memo);
    if (input.hold === true) return this.hold(r, { ...t, kind: t.kind || "send" }, args, who, memo);
    return this.run(r.name, t.tool, args, { agent: who.agent });
  }

  async hold(r, t, args, who, memo) {
    if (!this.deps.request) throw fail("failed", "the Gate is not running, so an outward call cannot be held");
    const { to } = target(args, r.name);
    const project = who.thread ? await this.projectOf(who, memo) : null;
    const held = await this.deps.request({ kind: t.kind, via: `mcp:${r.name}`, to, content: { server: r.name, tool: t.tool, arguments: args, summary: `${t.tool} on ${r.name}` },
      ...(who.thread ? { thread: who.thread } : {}), ...(project ? { project } : {}), ...(who.agent ? { agent: who.agent } : {}) });
    this.deps.emit("mcp.held", { server: r.name, tool: t.tool, id: held.id, kind: t.kind, agent: who.agent || null }, who.thread ? { thread: who.thread, ...(project ? { project } : {}) } : undefined);
    return { held: held.id, message: held.message };
  }

  /**
   * The Gate approved it: run exactly the approved arguments. The item is looked up again so the
   * server comes from the Gate's own record, and the server and tool are checked once more.
   * @param {{ id: string, to: string[], content: any }} input
   */
  async release({ id, to, content }) {
    const it = this.deps.item ? await this.deps.item(id) : null;
    if (!it || it.state !== "sending") throw fail("denied", `${id} is not an approved item being sent`);
    const server = String(it.via || "").replace(/^mcp:/, "");
    if (!isObj(content) || content.server !== server) throw fail("bad_input", `the approved content names server ${content && content.server}, but the item was held for ${server}`);
    const r = this.row(server);
    if (!r) throw fail("not_found", `the server ${server} was removed after this was held`);
    const t = this.findTool(r, content.tool);
    if (!t || t.tool !== content.tool) throw fail("denied", `${server} no longer has ${String(content.tool).slice(0, 80)} on`);
    const args = content.arguments ?? {};
    if (!isObj(args)) throw fail("bad_input", "the approved arguments are not an object");
    const final = this.retarget(args, to, it, server);
    return this.run(server, t.tool, final, { agent: it.agent || null, released: id });
  }

  /**
   * The Gate shows `to`; the server reads the arguments. They must agree. When the person changed
   * only `to`, it is written into the argument it came from; when both changed and differ, the
   * send is refused rather than guessing which one they meant.
   */
  retarget(args, to, it, server) {
    const dest = (Array.isArray(to) ? to : [to]).map(String).filter(Boolean);
    const now = target(args, server);
    if (!now.key) return args;
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (same(dest, now.to)) return args;
    const before = target((it.draft && it.draft.arguments) || {}, server);
    if (before.key === now.key && same(before.to, now.to)) return { ...args, [now.key]: now.list || dest.length > 1 ? dest : dest[0] };
    throw fail("bad_input", `to (${dest.join(", ")}) and arguments.${now.key} (${now.to.join(", ")}) disagree; edit them to match`);
  }

  /** Call a tool on a running (or started) server, with one retry after a 401 or a lost session. */
  async run(name, tool, args, { agent = null, released = null } = {}) {
    const t0 = this.now();
    const s = this.state(name);
    s.inflight++;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    let ok = false;
    // Whether the call may have reached the server, for a caller deciding if a retry could send
    // twice: "no" until the request is handed to the client, and after the server's own refusal.
    let asked = false;
    try {
      let client = await this.ensure(name);
      let result;
      try { asked = true; result = await client.callTool(tool, args); }
      catch (e) {
        const code = /** @type {any} */ (e)?.code;
        if (code === "unauthorized" || code === "session_expired") {
          if (code === "unauthorized") this.creds.invalidate(this.must(name).auth, this.must(name).auth.scopes);
          await this.drop(name, client);
          client = await this.ensure(name);
          result = await client.callTool(tool, args);
        } else {
          if (["exited", "closed", "unreachable"].includes(code) && s.client === client) this.crashed(name, client, e);
          throw e;
        }
      }
      ok = !(result && result.isError);
      return this.cap(this.creds.scrubAll(result));
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      throw this.scrubbed(e, { reached: asked && !NOT_REACHED.has(code) ? "maybe" : "no" });
    } finally {
      s.inflight--;
      const at = this.now();
      if (this.row(name)) this.db.prepare("UPDATE mcp_servers SET last_used = ? WHERE name = ?").run(at, name);
      this.deps.emit("mcp.called", { server: name, tool, ok, ms: at - t0, agent, ...(released ? { released } : {}) });
      this.arm(name);
    }
  }

  /** Cut a result a model reads. The whole JSON is kept under MAX_RESULT, text first. */
  cap(result) {
    const max = this.deps.maxResult || MAX_RESULT;
    const s = JSON.stringify(result ?? null);
    if (s.length <= max) return result;
    return { content: [{ type: "text", text: s.slice(0, max) + " [cut: the result was " + s.length + " characters]" }], truncated: true, ...(result && result.isError ? { isError: true } : {}) };
  }

  // ---- lifecycle ----

  /**
   * The running client, starting it if need be. Concurrent callers share one start. A failed
   * server restarts on the next call until its budget is spent, then stays failed.
   * @param {string} name @param {{ budget?: boolean, force?: boolean }} [o]
   */
  async ensure(name, o = {}) {
    if (this.stopping) throw fail("closed", "the MCP hub is stopping");
    const s = this.state(name);
    if (s.client) return s.client;
    if (s.starting) return s.starting;
    if (!o.force && s.state === "failed") {
      const recent = s.crashes.filter(at => this.now() - at < RESTART_WINDOW);
      s.crashes = recent;
      if (recent.length > RESTARTS) throw fail("failed", `${name} failed ${recent.length} times in five minutes and stays failed until mcp.restart${s.error ? `: ${s.error}` : ""}`);
    }
    s.starting = this.start(name, o.budget !== false).finally(() => { s.starting = null; });
    return s.starting;
  }

  /** Start one server: connect, initialize, list and cache its tools. */
  async start(name, budget) {
    const r = this.must(name);
    const s = this.state(name);
    s.state = "starting";
    const t0 = this.now();
    let client = null;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          client = await this.open(r, s);
          s.lastClient = client;
          await client.initialize();
          const tools = await client.listTools();
          await this.refresh(name, tools);
          break;
        } catch (e) {
          if (client) { const c = client; client = null; await c.close().catch(() => {}); }
          if (/** @type {any} */ (e)?.code === "unauthorized" && attempt === 0) { this.creds.invalidate(r.auth, r.auth.scopes); continue; }
          throw e;
        }
      }
      s.client = client; s.state = "running"; s.error = null;
      this.deps.emit("mcp.started", { name, transport: r.transport, tools: (this.must(name).cache || []).length, ms: this.now() - t0 });
      this.arm(name);
      return client;
    } catch (e) {
      const err = this.scrubbed(e);
      s.state = "failed";
      s.error = cut(this.lastLine(s.lastClient) || err.message, 300);
      if (budget) s.crashes.push(this.now());
      this.deps.emit("mcp.failed", { name, error: cut(s.error, 200) });
      this.deps.log?.(`${name} failed to start: ${cut(err.message, 200)}`);
      throw err;
    }
  }

  /** Connect with the credential built for this server only: env for its child, a header per request. */
  async open(r, s) {
    /** @type {any} */
    let client = null;
    const onExit = (code, signal) => { if (client && s.client === client) this.crashed(r.name, client, new McpError("exited", `exited (${signal || `code ${code}`})`)); };
    const opts = { onExit, ...(this.deps.timeout ? { timeout: this.deps.timeout } : {}) };
    if (r.transport === "stdio") {
      const env = { ...r.vars, ...(await this.creds.env(r.env)) };
      client = await this.deps.connect({ transport: "stdio", command: r.command, args: r.args, ...(r.cwd ? { cwd: r.cwd } : {}) }, { ...opts, env });
    } else {
      const headers = async () => ({ ...r.headers, ...(await this.creds.headers(r.auth, { scopes: r.auth.scopes })) });
      client = await this.deps.connect({ transport: /** @type {"http"|"sse"} */ (r.transport), url: r.url }, { ...opts, headers });
    }
    return client;
  }

  /** Store the tool list when it differs from the cache. */
  async refresh(name, tools) {
    const clean = (tools || []).filter(t => t && typeof t.name === "string" && t.name).slice(0, 1000)
      .map(t => ({ name: t.name, description: typeof t.description === "string" ? cut(t.description, 2000) : "", inputSchema: isObj(t.inputSchema) ? t.inputSchema : { type: "object" },
        ...(isObj(t.annotations) ? { annotations: t.annotations } : {}) }));
    const r = this.must(name);
    const next = JSON.stringify(clean);
    if (JSON.stringify(r.cache) === next) return;
    this.db.prepare("UPDATE mcp_servers SET tools_cache = ?, cached_at = ? WHERE name = ?").run(next, this.now(), name);
    this.deps.emit("mcp.refreshed", { name, tools: clean.length });
  }

  /** The server went away on its own. */
  crashed(name, client, e) {
    const s = this.state(name);
    if (s.client !== client) return;
    s.client = null;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.state = "failed";
    s.error = cut(this.lastLine(client) || this.scrubbed(e).message, 300);
    s.crashes.push(this.now());
    this.deps.emit("mcp.failed", { name, error: cut(s.error, 200) });
  }

  /** Stop the idle clock, or start it when nothing is in flight. */
  arm(name) {
    const s = this.live.get(name);
    if (!s || !s.client) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (s.inflight > 0) return;
    const r = this.row(name);
    const idle = (r && r.idle) || this.deps.idle || DEFAULT_IDLE;
    s.timer = setTimeout(() => { s.timer = null; if (s.inflight === 0) this.stopServer(name, "idle").catch(() => {}); }, idle);
    s.timer.unref?.();
  }

  /** Close a client that failed with a retryable error, so the next ensure starts a fresh one. */
  async drop(name, client) {
    const s = this.state(name);
    if (s.client === client) { s.client = null; s.state = "stopped"; }
    await client.close().catch(() => {});
  }

  async stopServer(name, reason) {
    const s = this.live.get(name);
    if (!s) return;
    if (s.starting) await s.starting.catch(() => {});
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    const c = s.client;
    if (!c) return;
    s.client = null;
    await c.close().catch(() => {});
    // A call that came in while it closed may have started a new one already.
    if (!s.client && !s.starting) s.state = "stopped";
    this.deps.emit("mcp.stopped", { name, reason });
  }

  async stop() {
    this.stopping = true;
    await Promise.all([...this.live.keys()].map(n => this.stopServer(n, "shutdown")));
  }

  // ---- scrubbing ----

  stderrOf(client) {
    if (!client || typeof client.stderr !== "function") return [];
    return client.stderr().slice(-STDERR_LINES).map(l => cut(this.creds.scrub(l), 400));
  }

  lastLine(client) { const l = this.stderrOf(client); return l.length ? l[l.length - 1] : ""; }

  message(e) { return this.creds.scrub(String(/** @type {any} */ (e)?.message || e)); }

  /** An error safe to hand back: scrubbed of every value, with its code kept. */
  /** @param {any} e @param {Record<string, any>} [detail] what the caller may act on, passed through by the registry */
  scrubbed(e, detail) {
    const code = typeof /** @type {any} */ (e)?.code === "string" ? /** @type {any} */ (e).code : "failed";
    return Object.assign(new Error(cut(this.message(e), 1000)), { code, ...(detail ? { detail } : {}) });
  }
}
