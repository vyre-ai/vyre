// @ts-check
// Vault-routed API access (0.2 plan: team/0.2/plans/vault.md "vault-routed API access", PLAN.md
// P5): the pure engine behind the `api-credential` item kind and the `vault.request` tool this
// file does not itself define. Three jobs, and why they live together:
// - `normalize()` checks an api-credential's shape (auth, a host allowlist, an endpoint
//   classification table) the same way core/mcp/hub.js's `normalize()` checks a server row.
// - `classify()` decides whether a method+path is a read (runs at once) or outward (held at the
//   Gate as send/spend/delete), from the credential's own `endpoints` table plus a small built-in
//   preset per well-known API, defaulting anything unmatched and not GET/HEAD to outward - never
//   a silent guess toward read.
// - `checkTarget()` is the SSRF guard (reviewer X-M4, PLAN.md P2-M1): stricter than
//   core/mcp/hub.js's `checkUrl`/`httpAllowed`, on purpose. A hosted MCP server may legitimately
//   live on loopback or the tailnet; an api-credential's target is always a public vendor API, so
//   this refuses private, loopback, link-local, CGNAT/tailnet and cloud-metadata addresses
//   outright, with no allowlist override, and it resolves the hostname itself and checks every
//   address that comes back (not just the first), so a hostname that answers differently on a
//   second lookup (DNS rebinding) cannot pass the check on one address and connect to another.
// This file has no ctx, no vault, no gate, no network client: it decides yes/no and hands back
// what the caller (vault.request) needs to actually connect to the address it already validated,
// so nothing here and nothing downstream does a second, unchecked lookup.

import crypto from "node:crypto";

const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST = /^\*\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$|^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "*"];
const KINDS = ["read", "send", "spend", "delete"];

// ---- normalize ----

function checkRef(ref, where) {
  const r = typeof ref === "string" ? { item: ref } : ref;
  if (!isObj(r) || typeof r.item !== "string" || !ITEM.test(r.item)) throw bad(`${where} must name a vault item`);
  if (r.field !== undefined && (typeof r.field !== "string" || !r.field || r.field.length > 64)) throw bad(`${where}.field must be a field name`);
  return r.field ? { item: r.item, field: r.field } : { item: r.item };
}

/** A secret may live in another vault item (item, field?) or, left out, in this credential's own sealed `secret` field, which nothing can release. */
const optionalRef = a => (a.item === undefined && a.field === undefined ? {} : checkRef({ item: a.item, field: a.field }, "auth"));

/**
 * @param {any} a
 * @returns {{ type: "service-account", item: string, field?: string, subject: string, scopes: string[] } |
 *   { type: "oauth", client: { item: string, field?: string }, authorize_uri: string, token_uri: string, scopes: string[] } |
 *   { type: "bearer"|"api-key", item: string, field?: string, header?: string, format?: string }}
 */
function normalizeAuth(a) {
  if (!isObj(a) || !["service-account", "oauth", "bearer", "api-key"].includes(a.type)) throw bad('auth.type must be "service-account", "oauth", "bearer" or "api-key"');
  if (a.type === "service-account") {
    const ref = optionalRef(a);
    if (typeof a.subject !== "string" || !a.subject) throw bad("a service-account credential needs auth.subject (the address it acts as), fixed here, never in a request");
    if (!Array.isArray(a.scopes) || !a.scopes.length || !a.scopes.every(s => typeof s === "string" && s)) throw bad("auth.scopes must be a non-empty list of strings");
    return { type: "service-account", ...ref, subject: a.subject, scopes: [...new Set(a.scopes)] };
  }
  if (a.type === "oauth") {
    if (!isObj(a.client)) throw bad("an oauth credential needs auth.client naming a vault item with client_id (and client_secret if it needs one)");
    const client = checkRef(a.client, "auth.client");
    if (typeof a.authorize_uri !== "string" || !/^https:/.test(a.authorize_uri)) throw bad("auth.authorize_uri must be https");
    if (typeof a.token_uri !== "string" || !/^https:/.test(a.token_uri)) throw bad("auth.token_uri must be https");
    // Scopes are optional: a provider that takes none (Clio Manage) leaves them out, and the refresh request then carries no `scope` at all.
    if (a.scopes !== undefined && (!Array.isArray(a.scopes) || !a.scopes.every(s => typeof s === "string"))) throw bad("auth.scopes must be a list of strings, or left out");
    return { type: "oauth", client, authorize_uri: a.authorize_uri, token_uri: a.token_uri, scopes: [...new Set((a.scopes ?? []).map(String))] };
  }
  const ref = optionalRef(a);
  const out = { type: a.type, ...ref };
  if (a.header !== undefined) { if (typeof a.header !== "string" || !a.header) throw bad("auth.header must be a header name"); out.header = a.header.toLowerCase(); }
  if (a.format !== undefined) { if (typeof a.format !== "string" || !a.format.includes("{value}")) throw bad("auth.format needs {value}"); out.format = a.format; }
  return out;
}

/**
 * Suffixes anyone can rent a subdomain or a bucket under. A wildcard here would let an injected
 * agent put the person's data in a URL on infrastructure an attacker controls, with the person's
 * credential attached (reviewer M8), so these are allowed only as an exact host the person names.
 */
export const SHARED_SUFFIXES = ["googleapis.com", "googleusercontent.com", "amazonaws.com", "cloudfront.net", "appspot.com", "run.app", "web.app", "firebaseapp.com",
  "azurewebsites.net", "blob.core.windows.net", "windows.net", "azureedge.net", "cloudfunctions.net", "workers.dev", "pages.dev", "herokuapp.com", "vercel.app",
  "netlify.app", "github.io", "githubusercontent.com", "onrender.com", "fly.dev", "railway.app", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "repl.co", "glitch.me"];

/** A hostname that is really an address: dotted digits, a lone number (decimal or 0x hex), or bracketed IPv6. */
const looksLikeIp = h => /^\[/.test(h) || h.includes(":") || /^(0x[0-9a-f]+|\d+)$/i.test(h.split(".").pop() || "");

/** A host entry: an exact hostname, or one leading "*." wildcard. Nothing else matches, ever. */
function normalizeHost(h) {
  if (typeof h !== "string" || !HOST.test(h) || looksLikeIp(h)) throw bad(`${String(h).slice(0, 60)} is not a host (an exact hostname, or one leading "*.")`);
  const host = h.toLowerCase();
  if (host.startsWith("*.")) {
    const rest = host.slice(2);
    if (SHARED_SUFFIXES.some(s => rest === s || rest.endsWith("." + s))) throw bad(`${host} is a wildcard on a domain anyone can rent a name under; name the exact host instead`);
  }
  return host;
}

/**
 * @param {any} e @returns {{ method: string, path: string, kind: string }}
 */
function normalizeEndpoint(e) {
  if (!isObj(e) || !METHODS.includes(String(e.method).toUpperCase()) || !KINDS.includes(e.kind) || typeof e.path !== "string" || !e.path)
    throw bad('an endpoint entry is { method: "GET"|"POST"|...|"*", path: "/a/*/b", kind: "read"|"send"|"spend"|"delete" }');
  return { method: String(e.method).toUpperCase(), path: e.path, kind: e.kind };
}

/**
 * The stored shape for an `api-credential` item, checked. Refuses anything that would let a
 * request choose its own DWD subject, an unbounded host, or a value in the row itself.
 * @param {any} i
 */
export function normalize(i) {
  if (!isObj(i)) throw bad("an api-credential needs auth, hosts and, optionally, endpoints");
  const auth = normalizeAuth(i.auth);
  if (!Array.isArray(i.hosts) || !i.hosts.length) throw bad("hosts must be a non-empty list (an exact hostname, or one leading \"*.\")");
  const hosts = i.hosts.map(normalizeHost);
  const endpoints = Array.isArray(i.endpoints) ? i.endpoints.map(normalizeEndpoint) : [];
  const readers = i.readers === undefined ? undefined : normalizeReaders(i.readers);
  const scope = i.scope === undefined ? undefined : normalizeScope(i.scope);
  const rate = i.rate === undefined ? undefined : normalizeRate(i.rate);
  const service = i.service === undefined ? undefined : normalizeService(i.service);
  return { auth, hosts, endpoints, ...(readers ? { readers } : {}), ...(scope ? { scope } : {}), ...(rate ? { rate } : {}), ...(service ? { service } : {}) };
}

/**
 * `service: { allow, deny }`: what a Flow's "Call a service" step may reach through this credential (core/vault/service.js), each rule `{ method?, path }`. A path is exact, `*` is one
 * segment, a trailing `/*` is the rest; deny wins and the default is no. Written with the credential, so only a person's own surface sets it. A credential with no `service` is not a connector.
 * @param {any} sv @returns {{ allow: { method?: string, path: string }[], deny: { method?: string, path: string }[] }}
 */
function normalizeService(sv) {
  if (!isObj(sv)) throw bad("service is { allow: [{ method?, path }], deny: [{ method?, path }] }");
  const rule = (/** @type {any} */ r) => {
    if (!isObj(r) || typeof r.path !== "string" || !/^\/[A-Za-z0-9._~\/*-]{0,200}$/.test(r.path) || /(^|\/)\.\.?(\/|$)/.test(r.path) || /\*[^/]|[^/]\*/.test(r.path) || r.path.slice(0, -2).includes("**")) throw bad("a service rule is { method?, path }: a path from the root, with `*` for one whole segment or a trailing /*");
    if (r.method !== undefined && !METHODS.includes(String(r.method).toUpperCase())) throw bad("a service rule's method is GET, HEAD, POST, PUT, PATCH, DELETE or *");
    return { ...(r.method !== undefined && r.method !== "*" ? { method: String(r.method).toUpperCase() } : {}), path: r.path };
  };
  const list = (/** @type {any} */ l, /** @type {string} */ w) => { if (l === undefined) return []; if (!Array.isArray(l) || l.length > 100) throw bad(`service.${w} is a list of rules`); return l.map(rule); };
  return { allow: list(sv.allow, "allow"), deny: list(sv.deny, "deny") };
}

/**
 * `rate: { per_minute }`: how many requests a minute this credential may make at its provider, for the whole Space (every Flow, session and forwarded program that uses it shares one
 * allowance). Left out means no limit of ours; a provider that caps its callers (Clio Manage, about 50 a minute) gets its number here so one busy job cannot spend everyone's.
 * @param {any} r
 */
function normalizeRate(r) {
  if (!isObj(r) || !Number.isInteger(r.per_minute) || r.per_minute < 1 || r.per_minute > 6000) throw bad("rate is { per_minute: a whole number from 1 to 6000 }");
  return { per_minute: r.per_minute };
}

/**
 * `scope`: which named agents and which projects may read through this credential without being asked, the same
 * { projects, agents } a connection carries ("*" or a list each). A credential with no scope is for the person and
 * the assistant only: a project's agent never reads through a connection nobody gave its project.
 * @param {any} sc @returns {{ projects: "*" | string[], agents: "*" | string[] }}
 */
function normalizeScope(sc) {
  if (!isObj(sc)) throw bad('scope is { projects: "*" | [ids], agents: "*" | [names] }');
  const one = (/** @type {any} */ v, /** @type {string} */ what) => {
    if (v === undefined || v === "*") return "*";
    if (!Array.isArray(v) || v.length > 64 || !v.every(x => typeof x === "string" && x && x.length <= 128)) throw bad(`scope.${what} must be "*" or a list`);
    return [...new Set(v)];
  };
  return { projects: one(sc.projects, "projects"), agents: one(sc.agents, "agents") };
}

/**
 * May a model call read through this credential? The person's own session and the assistant are not asked here. A named agent, or a
 * session bound to a project, needs the credential's scope to name its agent (or "*") AND its project (or "*"): a scope of "*" on
 * both is "everyone", an absent scope is "no one".
 * @param {{ scope?: { projects: "*" | string[], agents: "*" | string[] } }} config @param {{ agent?: string, project?: string }} who
 */
export function scopeAllows(config, { agent, project }) {
  const sc = config.scope;
  if (!sc) return false;
  // Fail closed: an absent agent or project matches only "*", never a list, so a caller that names neither is not let in by a scope that names someone.
  const agentOk = sc.agents === "*" || Boolean(agent && sc.agents.includes(agent));
  const projectOk = sc.projects === "*" || Boolean(project && sc.projects.includes(project));
  return agentOk && projectOk;
}

/**
 * `readers`: the modules the person let read through this credential, each for named paths only
 * (a calendar, not a mailbox). Written with the credential, which only a person's own surface can
 * do, so it is the person's own act and needs no second grant. A reader may only make calls the
 * credential classifies as reads; anything outward is refused to it, never held.
 * @param {any} r @returns {{ module: string, paths: string[] }[]}
 */
function normalizeReaders(r) {
  if (!Array.isArray(r) || r.length > 8) throw bad("readers is a short list of { module, paths }");
  return r.map(e => {
    if (!isObj(e) || typeof e.module !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(e.module)) throw bad("a reader names a module");
    // A path is a literal prefix, optionally ending in one `*`; no other wildcard, and no encoded characters.
    if (!Array.isArray(e.paths) || !e.paths.length || e.paths.length > 16 || !e.paths.every(p => typeof p === "string" && /^\/[A-Za-z0-9._~\/-]{0,200}\*?$/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p))) throw bad("a reader lists the paths it may read: each starts with /, is plain text and may end in one *");
    return { module: e.module, paths: [...new Set(e.paths)] };
  });
}

/**
 * Whether a module may read this request through the credential: it is a listed reader, the call is
 * a read, and the path is one the person named for it.
 * @param {{ readers?: { module: string, paths: string[] }[] }} config @param {string} mod @param {string} pathAndQuery
 */
export function readerMayRead(config, mod, pathAndQuery) {
  const e = (config.readers || []).find(x => x.module === mod);
  if (!e) return false;
  const q = pathAndQuery.indexOf("?");
  const pathname = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  // Encoded slashes and dots are how a path is smuggled past a prefix (the server may decode %2f, the URL parser does not), so none is allowed.
  if (/%(2f|5c|2e|00)|;/i.test(pathname) || /(^|\/)\.\.?(\/|$)/.test(pathname)) return false;
  return e.paths.some(pat => {
    const prefix = pat.endsWith("*") ? pat.slice(0, -1) : pat;
    if (!pathname.startsWith(prefix)) return false;
    const rest = pathname.slice(prefix.length);
    // The prefix ends at a segment: the path is the prefix itself or goes on under it, never a longer name (calendarViewfoo).
    return pat.endsWith("*") ? rest === "" || prefix.endsWith("/") || rest.startsWith("/") : rest === "";
  });
}

// ---- classify ----

/** Presets for common vendor write endpoints, so a person adding "Graph, act as me" never has to
 * hand-classify sendMail themselves. Reviewed as security-sensitive: a wrong entry here silently
 * under-holds a real write for every credential that matches it. Checked ahead of a credential's
 * own `endpoints`, which may only add to this, never loosen it (a credential cannot mark a preset
 * write as a read). */
export const PRESETS = [
  { method: "POST", path: "/gmail/v1/users/*/messages/send", kind: "send", host: "gmail.googleapis.com", family: "gmail" },
  { method: "POST", path: "/gmail/v1/users/*/drafts/send", kind: "send", host: "gmail.googleapis.com", family: "gmail-draft" },
  { method: "POST", path: "/calendar/v3/calendars/*/events*sendUpdates=all*", kind: "send", host: "www.googleapis.com", family: "calendar" },
  { method: "POST", path: "/v1.0/*/sendMail", kind: "send", host: "graph.microsoft.com", family: "graph-mail" },
  { method: "POST", path: "/v1.0/*/microsoft.graph.send", kind: "send", host: "graph.microsoft.com", family: "graph-mail" },
  { method: "POST", path: "/v1/charges", kind: "spend", host: "api.stripe.com", family: "stripe" },
  { method: "POST", path: "/v1/payment_intents", kind: "spend", host: "api.stripe.com", family: "stripe" },
  { method: "POST", path: "/v1/payment_intents/*/confirm", kind: "spend", host: "api.stripe.com", family: "stripe" },
  { method: "POST", path: "/v1/refunds", kind: "spend", host: "api.stripe.com", family: "stripe" },
  { method: "POST", path: "/v1/transfers", kind: "spend", host: "api.stripe.com", family: "stripe" },
];

/**
 * Reads a preset lists on purpose, so an exact-host credential never has to spell them out.
 * Nothing else gets this: an unlisted GET is a read only when no wildcard host is in play.
 */
export const PRESET_READS = [
  { method: "GET", path: "/gmail/v1/users/*/messages*", host: "gmail.googleapis.com" },
  { method: "GET", path: "/gmail/v1/users/*/threads*", host: "gmail.googleapis.com" },
  { method: "GET", path: "/gmail/v1/users/*/labels*", host: "gmail.googleapis.com" },
  { method: "GET", path: "/calendar/v3/*", host: "www.googleapis.com" },
  { method: "GET", path: "/v1.0/*", host: "graph.microsoft.com" },
  { method: "GET", path: "/v1/*", host: "api.stripe.com" },
];

/** The preset (and its exact host and family) a method and path fall under, or null. Never loosens: classify() decides read or outward. */
export function presetFor(method, pathAndQuery) {
  const m = String(method || "").toUpperCase();
  return PRESETS.find(e => e.method === m && pathMatches(e.path, pathAndQuery)) || null;
}

/** Whether a GET or HEAD is on a preset's read list, on that preset's own host. */
export function presetRead(method, pathAndQuery, host) {
  const m = String(method || "").toUpperCase();
  return (m === "GET" || m === "HEAD") && PRESET_READS.some(e => e.host === String(host || "").toLowerCase() && pathMatches(e.path, pathAndQuery));
}

/** A `path` pattern with `*` wildcard segments (each `*` matches one or more of any character,
 * including "/") against a real path (query string included, so a pattern can gate on it). */
function pathMatches(pattern, path) {
  const re = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$");
  return re.test(path);
}

/**
 * Whether a request is a read (runs at once) or outward (held at the Gate). Checked in order:
 * the credential's own `endpoints`, then the built-in presets, then GET/HEAD with no match is
 * read, and anything else with no match is "send" - the safe default, more Gate holds rather than
 * a silent guess toward read.
 * @param {string} method @param {string} pathAndQuery @param {{ method: string, path: string, kind: string }[]} endpoints
 * @returns {{ kind: string, matched: boolean, from: "endpoints"|"preset"|"default" }}
 */
export function classify(method, pathAndQuery, endpoints) {
  const m = String(method || "").toUpperCase();
  for (const [from, table] of /** @type {const} */ ([["endpoints", endpoints || []], ["preset", PRESETS]])) {
    for (const e of table) if ((e.method === "*" || e.method === m) && pathMatches(e.path, pathAndQuery)) return { kind: e.kind, matched: true, from };
  }
  if (m === "GET" || m === "HEAD") return { kind: "read", matched: false, from: "default" };
  return { kind: "send", matched: false, from: "default" };
}

// ---- SSRF guard ----

/** A strict dotted quad as a 32-bit number: four parts, each 0 or 1 to 3 digits with no leading zero (so an octal or short form is null, and refused by callers). */
function v4num(ip) {
  const p = String(ip).split(".");
  if (p.length !== 4 || !p.every(x => /^(0|[1-9]\d{0,2})$/.test(x))) return null;
  const n = p.map(Number);
  return n.every(x => x <= 255) ? ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0 : null;
}
const inV4 = (n, base, bits) => { const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (n & mask) === (v4num(base) & mask); };

/** Every IPv4 range that must never be an api-credential's target: loopback, link-local
 * (includes cloud metadata's 169.254.169.254), private, CGNAT (which is also the tailnet range),
 * "this network" and its friends. */
const V4_BLOCKED = [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]];

function v4Blocked(ip) { const n = v4num(ip); return n === null ? true : V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits)); }

/**
 * An IPv6 address as 16 bytes, or null when it is not one. Handles "::", an embedded dotted IPv4
 * tail (::ffff:1.2.3.4) and the all-hex forms of the same address (::ffff:102:304), so no notation
 * hides an IPv4 address from the checks. A zone id (fe80::1%eth0) is refused: null.
 * @param {string} ip @returns {number[]|null}
 */
export function parseV6(ip) {
  let s = String(ip).toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":") || /[^0-9a-f:.]/.test(s)) return null;
  let tail = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4num(dotted[2]);
    if (n === null) return null;
    tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    s = dotted[1] + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = part => (part === "" ? [] : part.split(":"));
  const head = words(halves[0]), rest = halves.length === 2 ? words(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const all = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (all.length !== 8 || !all.every(w => /^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes = all.flatMap(w => { const v = parseInt(w, 16); return [v >> 8, v & 255]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * An IPv6 address that may never be a target: loopback, unspecified, link-local, unique-local and
 * site-local, multicast, documentation, discard and Teredo ranges, AWS's metadata address, and any
 * address that carries an IPv4 one (mapped, compatible, NAT64, 6to4) whose IPv4 is itself blocked.
 */
function v6Blocked(ip) {
  const b = parseV6(ip);
  if (!b) return true;
  const zero = (from, to) => b.slice(from, to).every(x => x === 0);
  const v4 = (o) => v4Blocked(`${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`);
  if (zero(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return v4(12); // ::ffff:a.b.c.d, mapped
  if (zero(0, 12)) return v4(12); // ::a.b.c.d, the deprecated compatible form
  if (b[0] === 0 && b[1] === 100 && b[2] === 255 && b[3] === 155 && zero(4, 12)) return v4(12); // 64:ff9b::/96, NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 2002::/16, 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32, Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32, documentation
  if (b[0] === 0x01 && zero(1, 8)) return true; // 100::/64, discard
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10, link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10, site-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7, unique-local (includes AWS's fd00:ec2::254)
  if (b[0] === 0xff) return true; // ff00::/8, multicast
  return false;
}

/** Whether a resolved address may never be an api-credential's target, whichever family it is. */
export function addressBlocked(ip) { return ip.includes(":") ? v6Blocked(ip) : v4Blocked(ip); }

/**
 * Whether a host name matches one entry in an allowlist: exact, or one leading "*." wildcard
 * matching exactly one label ("*.googleapis.com" matches "gmail.googleapis.com", never
 * "a.gmail.googleapis.com" and never a bare suffix a longer, unrelated name could satisfy).
 * @param {string} host @param {string[]} hosts
 */
export function hostAllowed(host, hosts) {
  const h = host.toLowerCase();
  return hosts.some(entry => {
    if (!entry.startsWith("*.")) return entry === h;
    const suffix = entry.slice(1); // ".googleapis.com"
    if (!h.endsWith(suffix)) return false;
    const label = h.slice(0, h.length - suffix.length);
    // Exactly one label, and a real hostname label: no "*", "_", space or other character a name server would treat specially.
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  });
}

/**
 * The full check before `vault.request` ever connects: a valid https url, on an allowed host,
 * whose every resolved address is a real public one. Returns the addresses to connect to, so the
 * caller pins the same lookup it just validated rather than resolving the hostname a second time.
 * @param {string} rawUrl @param {string[]} hosts @param {{ lookup?: (hostname: string) => Promise<{ address: string, family: number }[]> }} [deps]
 */
export async function checkTarget(rawUrl, hosts, deps = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw bad("url is not a valid address"); }
  if (u.protocol !== "https:") throw bad("url must be https; a vault-routed API credential never targets plain http");
  if (u.username || u.password) throw bad("url must not carry a user or password");
  if (u.port && u.port !== "443") throw bad("url must use the https port; a vault-routed API credential never targets another port");
  if (/%2f|%5c|%00|\\/i.test(u.pathname)) throw bad("url has an encoded slash, a backslash or a null in its path, which servers read differently than a classifier does");
  if (!hostAllowed(u.hostname, hosts)) throw bad(`${u.hostname} is not on this credential's allowed hosts`);
  const lookup = deps.lookup || defaultLookup;
  let addrs;
  try { addrs = await lookup(u.hostname); } catch { throw bad(`${u.hostname} could not be resolved`); }
  if (!addrs.length) throw bad(`${u.hostname} resolved to no address`);
  for (const a of addrs) if (addressBlocked(a.address)) throw bad(`${u.hostname} resolves to ${a.address}, a private, loopback, link-local or metadata address, which a vault-routed API credential may never reach`);
  return { url: u, addresses: addrs.map(a => a.address) };
}

async function defaultLookup(hostname) {
  const dns = await import("node:dns/promises");
  return dns.lookup(hostname, { all: true, verbatim: true });
}


// ---- the request itself: headers, url, what it does, what the person sees, what they approve ----

/** Headers a caller may never set: the credential owns authentication, the connection owns the rest. */
const FORBIDDEN_HEADERS = new Set(["authorization", "proxy-authorization", "host", "cookie", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect", "x-forwarded-for", "x-forwarded-host", "forwarded",
  // A read that a header turns into a write: many frameworks honour these, and a GET runs unasked.
  "x-http-method-override", "x-http-method", "x-method-override"]);

/**
 * The headers a caller asked to add, lower-cased and checked: no authentication (the credential
 * adds that), no framing, no line breaks. Returns a fresh object.
 * @param {any} h @returns {Record<string, string>}
 */
export function checkHeaders(h) {
  if (h === undefined || h === null) return {};
  if (!isObj(h)) throw bad("headers must be an object of strings");
  const out = /** @type {Record<string, string>} */ ({});
  const names = Object.keys(h);
  if (names.length > 20) throw bad("at most 20 headers");
  for (const k of names) {
    const name = k.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw bad(`"${k.slice(0, 40)}" is not a header name`);
    if (FORBIDDEN_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) throw bad(`${name} is set by the credential or the connection, never by a request`);
    const v = h[k];
    if (typeof v !== "string" || v.length > 2000 || /[\r\n\0]/.test(v)) throw bad(`header ${name} must be a single-line string`);
    out[name] = v;
  }
  return out;
}

/**
 * The request's url with its query merged in. A query already in the url and one in `query` are
 * both kept; values are strings, numbers or booleans, or lists of them.
 * @param {any} rawUrl @param {any} query @returns {string}
 */
export function buildUrl(rawUrl, query) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw bad("url is not a valid address"); }
  if (query !== undefined && query !== null) {
    if (!isObj(query)) throw bad("query must be an object");
    for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : [v]) {
      if (!["string", "number", "boolean"].includes(typeof x)) throw bad(`query.${k.slice(0, 40)} must be a string, number or boolean`);
      u.searchParams.append(k, String(x));
    }
  }
  u.hash = "";
  return u.toString();
}

/**
 * Refuse a query that asks the server to treat the call as another method (`_method=DELETE`), which
 * would turn a GET, run at once, into a write nobody classified. @param {URL} u
 */
export function checkQuery(u) {
  for (const k of u.searchParams.keys()) if (/^(_method|x-http-method(-override)?|x-method-override|\$?httpmethod|_httpmethod)$/i.test(k))
    throw bad(`the query names ${k.slice(0, 40)}, which asks the server to use another method; use the method itself`);
}

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const EMAIL_IN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const uniq = a => [...new Set(a.map(x => String(x).trim()).filter(Boolean))].slice(0, 50);

/** A body as fields, whether it was sent as JSON or a form; {} when it is neither or will not parse. */
function bodyFields(body, contentType) {
  if (body === undefined || body === null || body === "") return {};
  if (isObj(body)) return body;
  const text = String(body);
  try {
    if (/x-www-form-urlencoded/i.test(contentType || "")) return Object.fromEntries(new URLSearchParams(text));
    const j = JSON.parse(text);
    return isObj(j) ? j : {};
  } catch { return {}; }
}

/** The addresses in the To, Cc and Bcc headers of an RFC 822 message, base64url as Gmail's `raw` carries it. */
function mimeRecipients(raw) {
  let mime = "";
  try { mime = Buffer.from(String(raw), "base64url").subarray(0, 65536).toString("utf8"); } catch { return []; }
  const head = mime.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const found = [];
  for (const line of head.split(/\r?\n/)) if (/^(to|cc|bcc)\s*:/i.test(line)) found.push(...(line.match(EMAIL_IN) || []));
  return uniq(found);
}

/**
 * What a request does, read from its parsed fields by the preset that recognises it, never from
 * free text: who receives it, and for a payment, how much and to whom. Empty for a request no
 * preset recognises; the caller then names the host. `amount` is in the currency's main unit.
 * @param {{ family?: string }|null} preset @param {{ body?: any, contentType?: string }} req
 * @returns {{ recipients: string[], amount?: number, currency?: string, payee?: string }}
 */
export function parseFields(preset, { body, contentType } = {}) {
  const f = bodyFields(body, contentType);
  switch (preset && preset.family) {
    case "gmail": return { recipients: mimeRecipients(f.raw) };
    case "graph-mail": {
      const m = isObj(f.message) ? f.message : {};
      const list = ["toRecipients", "ccRecipients", "bccRecipients"].flatMap(k => (Array.isArray(m[k]) ? m[k] : []).map(r => r && r.emailAddress && r.emailAddress.address));
      return { recipients: uniq(list.filter(x => typeof x === "string")) };
    }
    case "calendar": return { recipients: uniq((Array.isArray(f.attendees) ? f.attendees : []).map(a => a && a.email).filter(x => typeof x === "string")) };
    case "stripe": {
      const minor = Number(f.amount);
      const currency = typeof f.currency === "string" ? f.currency.toLowerCase() : undefined;
      const payee = [f.destination, f.customer, f.payment_intent, f.charge].find(x => typeof x === "string" && x);
      return { recipients: [], ...(Number.isFinite(minor) && minor >= 0 ? { amount: currency && ZERO_DECIMAL.has(currency) ? minor : minor / 100 } : {}),
        ...(currency ? { currency } : {}), ...(payee ? { payee } : {}) };
    }
    default: return { recipients: [] };
  }
}

const clean = (s, n) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

/**
 * The line on the held card, built by Vyre from parsed fields: who it acts as, what it does, to
 * whom or how much, and the host and path. Never a subject, a body or any other free text the
 * request carries (reviewer M10).
 * @param {{ kind: string, method: string, url: string, actingAs?: string, parsed: { recipients: string[], amount?: number, currency?: string, payee?: string } }} r
 */
export function summarize({ kind, method, url, actingAs, parsed }) {
  const u = new URL(url);
  const dest = `${u.hostname}${u.pathname}`;
  const who = actingAs ? ` as ${clean(actingAs, 80)}` : "";
  let what;
  if (kind === "spend") {
    const amt = parsed.amount !== undefined ? `${parsed.amount.toFixed(2)}${parsed.currency ? " " + parsed.currency.toUpperCase() : ""}` : "an amount Vyre could not read";
    what = `Pay ${amt}${parsed.payee ? " to " + clean(parsed.payee, 80) : ""}${who}`;
  } else if (kind === "delete") what = `Delete${who}`;
  else if (parsed.recipients.length) {
    const shown = parsed.recipients.slice(0, 5).map(x => clean(x, 80)).join(", ");
    what = `Send${who} to ${shown}${parsed.recipients.length > 5 ? ` and ${parsed.recipients.length - 5} more` : ""}`;
  } else what = `Send${who} (recipients not readable)`;
  return `${what} · ${method.toUpperCase()} ${clean(dest, 120)}`;
}

/** JSON with sorted keys, so the same request always hashes the same. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * What an approval binds to: the exact method, url, headers (the ones the caller sent, never the
 * credential's) and body, so the request that runs is the one the person saw (reviewer M10).
 * @param {{ credential: string, method: string, url: string, headers?: Record<string, string>, body?: any }} r
 */
export function approvalHash({ credential, method, url, headers, body }) {
  return crypto.createHash("sha256").update(stable({ credential, method: String(method).toUpperCase(), url, headers: headers || {}, body: body ?? null })).digest("hex");
}

/**
 * The options that make https.request connect to one already-validated address while the url's
 * own host name stays the Host header and the TLS server name, so the certificate is still checked
 * for the name the credential allows and no second DNS lookup can land anywhere else.
 * @param {URL} url @param {string} address @param {{ method?: string, headers?: Record<string, string>, timeout?: number }} [o]
 */
export function pinnedOptions(url, address, o = {}) {
  const family = address.includes(":") ? 6 : 4;
  return {
    protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname + url.search, method: o.method || "GET",
    headers: { ...(o.headers || {}), host: url.host }, servername: url.hostname, agent: false, timeout: o.timeout ?? 30_000,
    /** @type {(host: string, opts: any, cb: Function) => void} */
    lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
  };
}
