// kernel/seal/uses.js: the vault and Drive on the same grants and events as everything else. A credential is used without being seen: the
// caller supplies what to do, the kernel decides (`authorize`), the use runs once inside the vault or Drive adapter, and one typed event says
// what happened ("used for Gmail, 3 times today") without any value. The ActionDefs below are the vault, Drive and sealing entries of the
// action registry; the adapters register them with the kernel at install. Contract 6.1, 7.7; invariants 1 and 7.

import crypto from "node:crypto";

/** Registry entries (kernel/contracts/authorize.d.ts ActionDef). `sealed_ok` only where the sealing process runs the step model-free. */
export const ACTIONS = Object.freeze([
  // A credential's effect is not the vault's risk (R5-4): filling a login is bound to the origin it was lent for, a read-only API call is a read,
  // and any other request made with a key is an outward act that waits for a person like a send or a payment.
  { action: "vault.fill", resource_type: "credential", risk: "write", label: "Sign in with a login", gloss: "Fills a login on the site it was lent for, without showing it." },
  { action: "vault.totp", resource_type: "credential", risk: "write", label: "Use a one-time code", gloss: "Enters the current code without showing it." },
  { action: "vault.read", resource_type: "credential", risk: "read", label: "Read through a service key", gloss: "Looks something up with a key, changing nothing." },
  { action: "vault.call", resource_type: "credential", risk: "outward.send", label: "Act through a service key", gloss: "Makes a request that can change things at the service: a refund, a payment, a message." },
  { action: "vault.run", resource_type: "credential", risk: "admin", label: "Give a program a secret", gloss: "Puts the value in a program's environment." },
  { action: "vault.reveal", resource_type: "credential", risk: "admin", label: "Show a secret", gloss: "Shows the value to a person, on their own screen." },
  { action: "vault.share", resource_type: "credential", risk: "outward.share", label: "Share a login or key", gloss: "Lets someone outside the Space use it." },
  { action: "vault.rotate", resource_type: "credential", risk: "admin", label: "Rotate a key", gloss: "Replaces a key at the service that issued it." },
  { action: "drive.read", resource_type: "file", risk: "read", label: "Read a file", gloss: "Opens a file in a project or a Drive share." },
  { action: "drive.write", resource_type: "file", risk: "write", label: "Change a file", gloss: "Saves or edits a file." },
  { action: "drive.restore", resource_type: "file", risk: "admin", label: "Restore an older file or backup", gloss: "Replaces what is there now with an older version or a whole backup." },
  { action: "drive.share", resource_type: "file", risk: "outward.share", label: "Share a file", gloss: "Gives someone outside the Space access to a file." },
  { action: "drive.delete", resource_type: "file", risk: "outward.delete", label: "Delete a file", gloss: "Removes a file for good." },
  { action: "service.read", resource_type: "service", risk: "read", label: "Read from a connected service", gloss: "Reads (GET or HEAD) through a connector the Space holds, with the Space's own credential, never the person's." },
  { action: "service.call", resource_type: "service", risk: "outward.send", label: "Call a connected service", gloss: "Changes something at a connected service (POST, PUT, PATCH, DELETE). It asks first." },
  { action: "seal.put", resource_type: "record", risk: "write", label: "Seal a value", gloss: "Moves a value into the sealed store." },
  { action: "seal.use", resource_type: "record", risk: "write", label: "Fill a sealed slot", gloss: "Merges a sealed value into a document or message.", sealed_ok: true },
  { action: "seal.deliver", resource_type: "record", risk: "outward.send", draftable: true, label: "Send what was filled", gloss: "Sends a message or document that holds a sealed value." },
  { action: "seal.export", resource_type: "record", risk: "write", label: "Move a sealed value to another server", gloss: "Carries a sealed value, wrapped so only the new server can open it, when you approve the whole move. The sealing process asks for your own approval." },
  { action: "seal.reveal", resource_type: "record", risk: "admin", label: "Show a sealed value", gloss: "Shows it on your screen only, after Face ID." },
]);

/** fill and totp as themselves, a GET or HEAD API call as a read, any other or unknown method as an outward call, a program's environment as admin. */
export function credentialAction(kind, method = "GET") {
  if (kind === "fill") return "vault.fill";
  if (kind === "totp") return "vault.totp";
  if (kind === "run") return "vault.run";
  if (kind === "api") return ["GET", "HEAD"].includes(String(method).toUpperCase()) ? "vault.read" : "vault.call";
  return "vault.call";
}
const BAD = /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|%00|\\|[\u0000-\u001f\u007f]|\/\//i;
/** A file path under a project or Drive root: no dot segments, no encoded dots or slashes, no backslash, NUL or control characters, no empty segment. A grant for a folder must not reach outside it. */
export function safePath(p) {
  const s = String(p ?? "");
  const winBad = s.split("/").some(x => /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(x));
  // A segment that starts or ends with whitespace is another name to a Drive read than the one an authorized prefix names (" Clients/A"): refused with the rest.
  const edgeSpace = s.split("/").some(x => /^\s|\s$/.test(x));
  if (!s || s.startsWith("/") || BAD.test(s) || s.normalize("NFKC") !== s || winBad || edgeSpace) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  return s;
}
/**
 * The ONE canonical form of a request path, for every route check (a lent session's route, a Flow's connector, the vault's own rules): parse it as the URL parser will, refuse anything the
 * parser or a server could read differently (a backslash, a tab, a space or any control character or NUL, an encoded slash, backslash, dot or NUL, an empty segment, dot segments before
 * or after decoding, a double-encoded percent, a query or fragment, a form NFKC would change), decode percent-encoding exactly ONCE, and return the decoded path. Rules match this form and the
 * request is sent as exactly this form. Throws `bad_input`; callers answer every refusal alike.
 * @param {string} raw @returns {string}
 */
export function canonicalPath(raw) {
  const bad = () => Object.assign(new Error("bad_input"), { code: "bad_input" });
  const s = String(raw ?? "");
  if (!s.startsWith("/") || /[?#\\\s\u0000-\u001f\u007f]|%(2e|2f|5c|00|25)|\/\//i.test(s)) throw bad();
  let d;
  try { d = decodeURIComponent(s); } catch { throw bad(); }
  if (/[?#\\\s%\u0000-\u001f\u007f]|\/\//.test(d) || d.split("/").some(x => x === "." || x === "..") || d.normalize("NFKC") !== d) throw bad();
  let seen; try { seen = new URL(`https://x.invalid${s}`).pathname; } catch { throw bad(); }
  let back; try { back = decodeURIComponent(seen); } catch { throw bad(); }
  if (back !== d) throw bad();
  return d;
}
/**
 * The binding of an approval to ONE request (SV-2): a hash of the connector, the method, the canonical path, the query and the body. The held decision carries it, the retry with an
 * approval passes it back, and the vault recomputes it from the request it is about to send, so an approved id cannot release a different call. Throws `bad_input` on a path that is not canonical.
 * @param {{ connector: string, method: string, path: string, query?: any, body?: any, headers?: any, upload?: any, saveTo?: any }} r @returns {string}
 */
export function requestBind(r) {
  const canon = v => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`);
  return crypto.createHash("sha256").update(canon({ c: String(r.connector), m: String(r.method).toUpperCase(), p: canonicalPath(String(r.path).split(/[?#]/)[0]), q: r.query ?? null, b: r.body === undefined ? null : r.body, h: r.headers ? Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [String(k).toLowerCase(), v])) : null, u: r.upload ?? null, s: r.saveTo ?? null })).digest("base64url");
}
/** One URN segment (a credential name): no slash, dot segment, encoding or control character. */
export function segment(x) { const s = String(x ?? ""); if (!s || /[/\\%]|^\.+$|[\u0000-\u001f\u007f]/.test(s)) throw Object.assign(new Error("bad_input"), { code: "bad_input" }); return s; }
const EVENTS = { allow: { vault: "vault.used", drive: "file.accessed" }, deny: "access.refused" };
const noun = a => a.split(".")[0];

/**
 * @param {{ authorize: (i: any) => Promise<{ effect: string, decision: string, reason: string }>, append: (chain: any, e: { type: string, sv: number, subject: string, data: any, cause?: string }) => Promise<any> }} k
 */
export function createGuard({ authorize, append }) {
  /** Decide, run once, record. A refusal looks like absence to the caller; the true reason is in the event. */
  async function act(chain, { action, resource, service, data = {}, run }) {
    const d = await authorize({ chain, action, resource, input_class: service });
    if (d.effect === "deny") {
      await append(chain, { type: EVENTS.deny, sv: 1, subject: resource, data: { action, reason: d.reason, service: service ?? null }, cause: d.decision });
      return { status: "refused", error: { code: "not_found" } };
    }
    if (d.effect === "ask") return { status: "ask", decision: d.decision };
    const result = await run();
    await append(chain, { type: EVENTS.allow[noun(action)] ?? "access.used", sv: 1, subject: resource, data: { action, service: service ?? null, ...data }, cause: d.decision });
    return { status: "done", result };
  }
  return {
    act,
    /** Use a credential for a service. `run` receives nothing secret; the adapter that owns the vault does the use and returns only its outcome. */
    useCredential: async (chain, { item, service, kind = "api", method = "GET", run }) => act(chain, { action: credentialAction(kind, method), resource: `vyre://${chain.space}/credential/${segment(item)}`, service, data: { kind, ...(kind === "api" ? { method: String(method).toUpperCase() } : {}) }, run }),
    readFile: async (chain, { path, run }) => act(chain, { action: "drive.read", resource: `vyre://${chain.space}/file/${safePath(path)}`, run }),
  };
}

/** "Used for Gmail 3 times today, Stripe once" from `vault.used` events. @param {{ type: string, time: number, data: any, actor?: string }[]} events */
export function summarise(events, now = Date.now(), dayMs = 86_400_000) {
  const by = new Map();
  for (const e of events) {
    if (e.type !== "vault.used" || e.time < now - dayMs) continue;
    const k = e.data.service ?? "another service", cur = by.get(k) ?? { service: k, uses: 0, last: 0 };
    cur.uses++; cur.last = Math.max(cur.last, e.time); by.set(k, cur);
  }
  const rows = [...by.values()].sort((a, b) => b.uses - a.uses || a.service.localeCompare(b.service));
  const times = n => (n === 1 ? "once" : `${n} times`);
  return { rows, text: rows.length ? `Used for ${rows.map(r => `${r.service} ${times(r.uses)}`).join(", ")} today.` : "Not used today." };
}

/** An old `vault_audit` row as a typed event body (contract 7.7). Only the shape the audit already holds: item, who, origin, surface. */
export function foldAudit(row) {
  const kind = { release: "release", fill: "fill", relay: "relay", inject: "run", totp: "totp", "api-request": "api" }[row.action];
  if (!kind) return null;
  // An old audit row does not say which method an API request used, so it is folded as the stricter action.
  const action = { fill: "vault.fill", totp: "vault.totp", run: "vault.run", api: "vault.call", relay: "vault.call", release: "vault.run" }[kind];
  return { type: row.ok ? "vault.used" : "access.refused", sv: 1, data: { action, kind, item: row.name ?? null, service: row.origin ?? null, via: row.surface ?? null }, time: row.at };
}

/** A vault agent grant (core/vault/agents.js row) as a kernel grant input: the same lending, now in the one grants table. */
export function grantFromAgent(g, space) {
  return {
    subject: { kind: "actor", actor: { kind: "agent", id: g.agent, space } }, actions: ["vault.fill", "vault.totp"],
    resource: { prefix: `vyre://${space}/credential/${segment(g.item)}` },
    conditions: { where: { surfaces: ["harness", "mcp"] }, ...(g.expires ? { when: { expires: Number(g.expires) } } : {}), audience: [new URL(g.origin).host] },
    source: "vault:agent-grant", reason: `lent to ${g.agent} for ${g.origin}`,
  };
}

/**
 * Vault use at the point of use for a lent computer (DESIGN-local-runner.md section 3): the runner's egress proxy asks per request, the session must
 * hold a live lease, the vault resolves the credential for that route, and one event says it was used, never the value. Nothing is cached here.
 * @param {{ leaseOf: (session: string) => string | null, check: (i: { chain: any, id: string }) => Promise<{ space: string, device: string }>, resolve: (i: { space: string, ref: string, route: string }) => Promise<string>, emit?: (e: any) => void, chain: any }} o
 */
export function leasedUse({ leaseOf, check, resolve, emit = () => {}, chain }) {
  return async ({ ref, session, route, method, path }) => {
    const id = leaseOf(session); if (!id) throw Object.assign(new Error("no_lease"), { code: "no_lease" });
    const { space, member, device } = await check({ chain, id });
    const value = await resolve({ space, ref, route, ...(method ? { method, path } : {}) });
    emit({ type: "vault.used", space, member, device, ref, route, session });
    return value;
  };
}

// ---- credentialed calls from a lent computer: one mechanism, run at the home ----
const PATH_OK = x => typeof x === "string" && x.startsWith("/") && !x.slice(0, -2).includes("*") && (!x.includes("*") || x.endsWith("/*"));
const atPath = (pat, path) => (pat.endsWith("/*") ? path === pat.slice(0, -2) || path.startsWith(pat.slice(0, -1)) : path === pat);

/**
 * A credential route as the Space holds it: a host, the credential, and what may be done with it. `allow` lists `{ method, path }` pairs (a path is exact or ends in `/*`);
 * `deny` lists `{ method?, path }` and always wins; anything not allowed is denied. The older `methods` and `paths` shorthand means every listed method on every listed path
 * (methods default to GET and HEAD). Example: Gmail for one mailbox only under `users/me`: `allow: [{ method: "GET", path: "/gmail/v1/users/me/*" }]`.
 */
export function normalizeRoute(r) {
  if (!r || typeof r.route !== "string" || !r.route || typeof r.ref !== "string" || !r.ref) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  const allow = (Array.isArray(r.allow) ? r.allow : []).map(a => ({ method: String(a?.method).toUpperCase(), path: String(a?.path) }));
  const methods = (Array.isArray(r.methods) && r.methods.length ? r.methods : ["GET", "HEAD"]).map(m => String(m).toUpperCase());
  for (const p of Array.isArray(r.paths) ? r.paths : []) for (const m of methods) allow.push({ method: m, path: String(p) });
  const deny = (Array.isArray(r.deny) ? r.deny : []).map(d => ({ method: d?.method ? String(d.method).toUpperCase() : "*", path: String(d?.path) }));
  for (const a of allow) if (!/^[A-Z]+$/.test(a.method) || !PATH_OK(a.path)) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  for (const d of deny) if (!(d.method === "*" || /^[A-Z]+$/.test(d.method)) || !PATH_OK(d.path)) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  // Files (core/vault/forward-file.js): a size cap up and down (25 MB by default), the content types a body, a part or a response may have, and the Drive paths this route may read and write.
  const maxBytes = r.maxBytes === undefined ? 25 * 1024 * 1024 : Number(r.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > 1024 ** 3) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  const contentTypes = (Array.isArray(r.contentTypes) ? r.contentTypes : ["application/json", "application/x-www-form-urlencoded", "text/plain"]).map(t => String(t).toLowerCase());
  if (contentTypes.some(t => !/^[a-z0-9.+-]+\/([a-z0-9.+-]+|\*)$/.test(t))) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  const drive = { read: (r.drive?.read ?? []).map(String), write: (r.drive?.write ?? []).map(String) };
  for (const p of [...drive.read, ...drive.write]) if (!p || p.startsWith("/") || p.slice(0, -2).includes("*") || (p.includes("*") && !p.endsWith("/*"))) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  // Request headers the program may send besides the safe default (accept, content-type, validators): exact names the route's own record lists (core/vault/request.js forwardHeaders).
  const headers = (Array.isArray(r.headers) ? r.headers : []).map(h => String(h).toLowerCase());
  if (headers.some(h => !/^[a-z0-9-]{1,64}$/.test(h))) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  return Object.freeze({ route: r.route.toLowerCase(), ref: r.ref, allow, deny, maxBytes, contentTypes, drive, headers });
}
/** May this route do this? The path is checked as the kernel checks every path (no dot segments, encoded dots or slashes, backslashes). Deny wins, and the default is no. */
export function routeAllows(def, method, path) {
  const m = String(method ?? "").toUpperCase();
  let p; try { p = canonicalPath(String(path ?? "").split(/[?#]/)[0]); } catch { return false; }
  if (def.deny.some(d => (d.method === "*" || d.method === m) && atPath(d.path, p))) return false;
  return def.allow.some(a => a.method === m && atPath(a.path, p));
}

/**
 * A credentialed call from a lent computer. The program names a session, a host, a method, a path, its headers (never an authorization) and a body; the Space maps the
 * session to a route (`routesOf(session)` is the home's own record, set when the session was bound), the route's allow and deny lists are applied, the session's lease must
 * be live, and the request is RUN HERE at the home through `forward` (the vault's `vault.request` path). What goes back is a response (or `{ held }` for an outward call
 * waiting on a person), never a key, a token or a header value. One `vault.used` event names the use (host, method, path, status), never a body or a value.
 * @param {{ leaseOf: (session: string) => string | null, check: (i: { chain: any, id: string }) => Promise<{ space: string, member: string, device: string }>, routesOf: (session: string) => any[],
 *   forward: (i: any) => Promise<any>, forwardFile?: (i: any) => Promise<any>, emit?: (e: any) => void, chain: any }} o
 * A request with `upload`, `saveTo` or `stream` moves a file through `forwardFile`: the program names Drive paths, never bytes, and the route's own size cap, content types and Drive lists apply.
 */
export function leasedForward({ leaseOf, check, routesOf, forward, forwardFile, emit = () => {}, chain }) {
  return async req => {
    const id = leaseOf(req.session); if (!id) throw Object.assign(new Error("no_lease"), { code: "no_lease" });
    const { space, member, device } = await check({ chain, id });
    const host = String(req.route ?? "").toLowerCase(), method = String(req.method ?? "").toUpperCase(), path = String(req.path ?? "").split(/[?#]/)[0];
    const def = (routesOf(req.session) || []).find(r => r.route === host && routeAllows(r, method, path));
    if (!def) throw Object.assign(new Error("not_found"), { code: "not_found" }); // a refused request looks like absence
    const file = req.upload !== undefined || req.saveTo !== undefined || req.stream === true;
    if (file && !forwardFile) throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    const res = file
      ? await forwardFile({ space, ref: def.ref, route: def.route, method, path, query: req.query, headers: req.headers, session: req.session, upload: req.upload, saveTo: req.saveTo, stream: req.stream === true, limits: { maxBytes: def.maxBytes, contentTypes: def.contentTypes }, drive: def.drive, allow_headers: def.headers })
      : await forward({ space, ref: def.ref, route: def.route, method, path, query: req.query, headers: req.headers, body: req.body, session: req.session, allow_headers: def.headers });
    emit({ type: "vault.used", space, member, device, ref: def.ref, route: def.route, method, path, status: res?.status ?? null, held: res?.held ? true : undefined, session: req.session });
    return res;
  };
}
