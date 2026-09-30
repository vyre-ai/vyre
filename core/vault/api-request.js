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

/**
 * @param {any} a
 * @returns {{ type: "service-account", item: string, field?: string, subject: string, scopes: string[] } |
 *   { type: "oauth", client: { item: string, field?: string }, authorize_uri: string, token_uri: string, scopes: string[] } |
 *   { type: "bearer"|"api-key", item: string, field?: string, header?: string, format?: string }}
 */
function normalizeAuth(a) {
  if (!isObj(a) || !["service-account", "oauth", "bearer", "api-key"].includes(a.type)) throw bad('auth.type must be "service-account", "oauth", "bearer" or "api-key"');
  if (a.type === "service-account") {
    const ref = checkRef({ item: a.item, field: a.field }, "auth");
    if (typeof a.subject !== "string" || !a.subject) throw bad("a service-account credential needs auth.subject (the address it acts as), fixed here, never in a request");
    if (!Array.isArray(a.scopes) || !a.scopes.length || !a.scopes.every(s => typeof s === "string" && s)) throw bad("auth.scopes must be a non-empty list of strings");
    return { type: "service-account", ...ref, subject: a.subject, scopes: [...new Set(a.scopes)] };
  }
  if (a.type === "oauth") {
    if (!isObj(a.client)) throw bad("an oauth credential needs auth.client naming a vault item with client_id (and client_secret if it needs one)");
    const client = checkRef(a.client, "auth.client");
    if (typeof a.authorize_uri !== "string" || !/^https:/.test(a.authorize_uri)) throw bad("auth.authorize_uri must be https");
    if (typeof a.token_uri !== "string" || !/^https:/.test(a.token_uri)) throw bad("auth.token_uri must be https");
    if (!Array.isArray(a.scopes) || !a.scopes.length) throw bad("auth.scopes must be a non-empty list of strings");
    return { type: "oauth", client, authorize_uri: a.authorize_uri, token_uri: a.token_uri, scopes: [...new Set(a.scopes.map(String))] };
  }
  const ref = checkRef({ item: a.item, field: a.field }, "auth");
  const out = { type: a.type, ...ref };
  if (a.header !== undefined) { if (typeof a.header !== "string" || !a.header) throw bad("auth.header must be a header name"); out.header = a.header.toLowerCase(); }
  if (a.format !== undefined) { if (typeof a.format !== "string" || !a.format.includes("{value}")) throw bad("auth.format needs {value}"); out.format = a.format; }
  return out;
}

/** A host entry: an exact hostname, or one leading "*." wildcard. Nothing else matches, ever. */
function normalizeHost(h) {
  if (typeof h !== "string" || !HOST.test(h)) throw bad(`${String(h).slice(0, 60)} is not a host (an exact hostname, or one leading "*.")`);
  return h.toLowerCase();
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
  return { auth, hosts, endpoints };
}

// ---- classify ----

/** Presets for common vendor write endpoints, so a person adding "Graph, act as me" never has to
 * hand-classify sendMail themselves. Reviewed as security-sensitive: a wrong entry here silently
 * under-holds a real write for every credential that matches it. Checked ahead of a credential's
 * own `endpoints`, which may only add to this, never loosen it (a credential cannot mark a preset
 * write as a read). */
export const PRESETS = [
  { method: "POST", path: "/gmail/v1/users/*/messages/send", kind: "send" },
  { method: "POST", path: "/gmail/v1/users/*/drafts/send", kind: "send" },
  { method: "POST", path: "/calendar/v3/calendars/*/events*sendUpdates=all*", kind: "send" },
  { method: "POST", path: "/v1.0/*/sendMail", kind: "send" },
  { method: "POST", path: "/v1.0/*/microsoft.graph.send", kind: "send" },
  { method: "POST", path: "/v1/charges", kind: "spend" },
  { method: "POST", path: "/v1/payment_intents", kind: "spend" },
  { method: "POST", path: "/v1/payment_intents/*/confirm", kind: "spend" },
  { method: "POST", path: "/v1/refunds", kind: "spend" },
  { method: "POST", path: "/v1/transfers", kind: "spend" },
];

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

/** IPv4 octets as a 32-bit number. */
function v4num(ip) { const p = ip.split(".").map(Number); return p.length === 4 && p.every(n => n >= 0 && n <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null; }
const inV4 = (n, base, bits) => { const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (n & mask) === (v4num(base) & mask); };

/** Every IPv4 range that must never be an api-credential's target: loopback, link-local
 * (includes cloud metadata's 169.254.169.254), private, CGNAT (which is also the tailnet range),
 * "this network" and its friends. */
const V4_BLOCKED = [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["192.0.0.0", 24], ["198.18.0.0", 15]];

function v4Blocked(ip) { const n = v4num(ip); return n === null ? true : V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits)); }

/** An IPv6 address, unwrapping an IPv4-mapped one (::ffff:a.b.c.d), so that form cannot dodge the IPv4 checks. */
function v6Blocked(ip) {
  const low = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return v4Blocked(mapped[1]);
  if (low === "::1" || low === "::") return true; // loopback, unspecified
  if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // fe80::/10, link-local
  if (/^f[cd]/.test(low)) return true; // fc00::/7, unique local
  if (low.startsWith("fd00:ec2:")) return true; // AWS's IPv6 metadata address
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
    return label.length > 0 && !label.includes(".");
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
