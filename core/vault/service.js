// @ts-check
// core/vault/service.js: a Flow's "Call a service" (sessions' port, kernel/gateway/leases.js forward, connector form). The Flow names a CONNECTOR (an api-credential in this vault)
// and a method and path; it never holds a URL, host or key. What a Flow may reach through a connector is the credential's own `service` rules, `{ allow, deny }`, written by a
// person with the credential: deny wins, the default is no, and a credential with no `service` is not a connector at all. The kernel has already authorized the caller's chain
// (`service.read` or `service.call`, and the Drive paths a file moves); this adds the connector's own rules, then the same checks as every vault request (hosts, the SSRF guard,
// read or outward). Two internal tools, callable only by the kernel's lease module: `vault.service.catalog` (the rules, never a secret or a host) and `vault.service.forward`.

import crypto from "node:crypto";
import { canonicalPath, requestBind, safePath } from "../../kernel/seal/uses.js";

const bad = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const CONNECTOR = /^[A-Za-z0-9_.-]{1,64}$/;
const APPROVAL_TTL_MS = 24 * 60 * 60_000;
const IDEM_TTL_MS = 60 * 60_000, IDEM_MAX = 2000;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/** Does `pattern` match `pathname`? `*` is one segment; a trailing `/*` is the rest (and the bare prefix). No encoded slash or dot, so nothing is smuggled past a prefix. */
export function pathMatches(pattern, pathname) {
  if (/%(2f|5c|2e|00)|;/i.test(pathname) || /(^|\/)\.\.?(\/|$)/.test(pathname)) return false;
  const rest = pattern.endsWith("/*");
  const pat = (rest ? pattern.slice(0, -2) : pattern).split("/"), got = pathname.split("/");
  if (rest ? got.length < pat.length : got.length !== pat.length) return false;
  return pat.every((seg, i) => seg === "*" || seg === got[i]);
}

/** The allow rule that matched, for its host. @param {{ allow?: any[] } | undefined} rules */
export function ruleFor(rules, method, pathname) {
  return ((rules && rules.allow) || []).find(r => (!r.method || r.method === "*" || r.method === method) && pathMatches(r.path, pathname)) || null;
}

/** Deny wins, default no. @param {{ allow?: any[], deny?: any[] } | undefined} rules */
export function routeAllowed(rules, method, pathname) {
  if (!rules) return false;
  const hit = list => (list || []).some(r => (!r.method || r.method === "*" || r.method === method) && pathMatches(r.path, pathname));
  return hit(rules.allow) && !hit(rules.deny);
}

/** @param {ReturnType<typeof import("./request.js").ApiRequests.prototype.constructor>} _ */
export function registerService({ api, vault, internal, forwardFile, forwardHeaders, obj, str }) {
  /** idem key -> { at, result }: an outward call made once per `<run>:<step>`, so a retry after a crash returns the first answer instead of sending again. In memory: a restart forgets it, and the ask-first approval still guards the act. */
  const done = new Map();
  const remember = (k, result) => {
    const t = Date.now();
    for (const [x, v] of done) if (v.at < t - IDEM_TTL_MS) done.delete(x);
    if (done.size >= IDEM_MAX) done.delete(done.keys().next().value);
    done.set(k, { at: t, result });
  };
  /** approval id -> the request it was spent on (SV-2): single use, and only for the request the held decision bound it to. In memory; a restart forgets, and the kernel's own approval still expires. */
  const inflight = new Map();
  const callerOk = c => c === "kernel:leases" || c === "module:leases";

  internal("vault.service.catalog", "The connectors a Flow may call: { connectors: { <name>: { allow: [{ method?, path }], deny: [{ method?, path }], draft?, idempotency?, rate?, ops? } } }, the credential's own `service` rules and what a declared connector says beside them (the draft op, its idempotency header, its rate and each op's outward flag and read-back). No host, no secret. Only the kernel's lease module asks.",
    obj({}, []),
    async (_input, { caller }) => {
      if (!callerOk(String(caller))) throw bad("only the kernel's lease module reads the connector list", "denied");
      const connectors = {};
      for (const name of await vault.apiCredentialNames()) {
        try { const { config } = await vault.apiCredential(name); if (config.service) connectors[name] = { ...config.service, ...(config.operations ? { operations: config.operations } : {}) }; } catch { /* not readable: not a connector */ }
      }
      return { connectors };
    });

  internal("vault.service.forward", "A Flow's call through a connector: { connector, request: { method, path, query?, headers?, body?, upload?, saveTo? }, idem?, approval? }. Refused unless the connector's `service` rules allow the method and path. Returns { status, ok, headers, body (base64) }, or { saved } for a Drive save, or { held } when the vault itself must ask. Only the kernel's lease module calls it, after authorizing the caller's chain; `approval` is an ask-first task id the kernel has already seen approved.",
    obj({ connector: str, request: { type: "object" }, idem: str, approval: str }, ["connector", "request"]),
    async (input, { caller, files: given }) => {
      if (!callerOk(String(caller))) throw bad("only the kernel's lease module forwards a Flow's call", "denied");
      const name = String(input.connector || ""), r = isObj(input.request) ? input.request : {};
      if (!CONNECTOR.test(name)) throw bad("name a connector");
      const method = String(r.method || "GET").toUpperCase(), rawPath = String(r.path || "/");
      if (!METHODS.includes(method)) throw bad("a request names a method and a path");
      const audit = (ok, why) => vault.audit("api-request", name, `flow:${String(input.idem || "").slice(0, 80)}`, ok, why);
      let config;
      try { ({ config } = await vault.apiCredential(name)); } catch { throw bad("that request is not open to this caller", "not_found"); }
      // The same refusal for no such connector, a connector with no rules and a path the rules do not allow: nothing says which.
      // ONE canonical form (kernel/seal/uses.js canonicalPath, shared with the lent-session route check): refused if the parser or a server could read it differently, decoded once,
      // matched in that form and sent as exactly that form (SV-1).
      let path; try { path = canonicalPath(rawPath); } catch { path = null; }
      if (path === null || !routeAllowed(config.service, method, path)) { audit(false, `${method} refused by the connector's rules`); throw bad("that request is not open to this caller", "not_found"); }
      // A credential that names several hosts (one sign-in for Gmail and Calendar) says in each route which host it is on; a route with none is on the first exact host.
      const matched = ruleFor(config.service, method, path);
      const host = matched && matched.host && config.hosts.includes(matched.host) ? matched.host : config.hosts.find(h => !h.startsWith("*."));
      if (!host) throw bad("this connector names no exact host, so a Flow cannot reach it", "not_found");
      // Drive paths first, so the bind below covers the canonical forms: the same one-form refusal as request paths (dot segments, backslash, encoded slash, control characters, empty segments, and
      // here also a colon, a leading `~` and bidi or zero-width marks): `/Clients/A/../B/x` must not pass as under `Clients/A`.
      const files = Boolean(r.upload || r.saveTo);
      if (files) {
        const dp = x => { let q; try { q = safePath(String(x)); } catch { q = null; } if (q === null || /[:\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|^~/.test(q)) throw bad("that file is not open to this caller", "not_found"); return q; };
        if (r.upload?.drive?.path !== undefined) r.upload.drive.path = dp(r.upload.drive.path);
        if (Array.isArray(r.upload?.multipart)) for (const p of r.upload.multipart) if (p && p.drive && p.drive.path !== undefined) p.drive.path = dp(p.drive.path);
        if (r.saveTo !== undefined) r.saveTo = dp(r.saveTo);
      }
      const outward = method !== "GET" && method !== "HEAD";
      const key = input.idem ? `${name}\0${String(input.idem)}` : null;
      // A connector that declares an idempotency header gets the call's idem key in it, so the provider too sees one act once. Only on an outward call (a read has nothing to repeat), only when
      // the op does not opt out, and as a derived value: the key a Flow holds is a run and step id, which is not what a provider should see.
      const idemName = config.service.idempotency && config.service.idempotency.header, op = (config.service.ops || []).find(o => o.method === method && pathMatches(o.path, path));
      const idemHeaders = idemName && outward && input.idem && !(op && op.idempotent === false) ? { [idemName.toLowerCase()]: `vyre-${crypto.createHash("sha256").update(`${name}\0${String(input.idem)}`).digest("hex").slice(0, 40)}` } : null;
      const base = { credential: name, method, url: `https://${host}${path}`, ...(r.query ? { query: r.query } : {}), ...(r.headers || idemHeaders ? { headers: { ...(r.headers || {}), ...(idemHeaders || {}) } } : {}), ...(idemHeaders ? { allow_headers: [idemName] } : {}), ...(r.body !== undefined ? { body: r.body } : {}) };
      const who = `flow:${String(input.idem || "run").slice(0, 80)}`;
      /** What actually goes out, once. */
      const execute = async (/** @type {string | null} */ approval) => {
        let out;
        if (files) {
          // The Drive is THIS call's own door when the kernel hands one in (the caller's chain, FW-2), else the home's own handle (a rig with no kernel).
          const driveHandle = given || api.deps.files;
          if (!driveHandle) throw bad("the Drive is not wired to this vault", "unavailable");
          const drive = { read: [r.upload?.drive?.path, ...(Array.isArray(r.upload?.multipart) ? r.upload.multipart.map(p => p?.drive?.path) : [])].filter(x => typeof x === "string"), write: r.saveTo ? [String(r.saveTo)] : [] };
          const x = await forwardFile(api, { files: driveHandle }, { ...base, ...(r.upload ? { upload: r.upload } : {}), ...(r.saveTo ? { saveTo: r.saveTo } : {}), drive }, { caller: who });
          out = x.held ? x : { ...x, ...(x.body ? { body: x.body.toString("base64") } : {}) };
        } else if (approval && outward) {
          // The kernel saw the ask-first task approved, so the person is asked once: run exactly this request, re-checked, with the approval named in the audit row.
          const plan = await api.plan({ ...base, headers: forwardHeaders(base.headers, idemHeaders ? [idemName] : []) }, name);
          const x = await api.execute(plan, { who, released: approval, raw: true });
          out = { ...x, body: x.body.toString("base64"), kind: plan.kind };
        } else {
          const x = await api.forward(base, { caller: who });
          out = x.held ? x : { ...x, body: x.body.toString("base64") };
        }
        if (key && outward && !out.held) remember(key, out);
        return out;
      };
      const refuse = why => { audit(false, `${method} refused: ${why}`); return bad("that request is not open to this caller", "not_found"); };
      const runOnce = async (/** @type {string | null} */ approval) => {
        // From here to the call there is NO await: the claim, the in-flight record and the start of the request are one synchronous step, so two callers cannot both send.
        const p = execute(approval);
        if (key && outward) inflight.set(key, p);
        try { return await p; } finally { if (key && outward) inflight.delete(key); }
      };

      // SV-2: an approval releases ONE request: everything that changes what is sent is in the bind (connector, method, canonical path, query, body, headers, upload sources, saveTo); the held
      // decision carried it, the retry passes it back, and the vault recomputes it from what it is about to send. The id is claimed atomically in the vault's own database (spent for good, kept
      // 24 h, surviving a restart); a replay of the same idem and bind gets the first call's answer, in flight or finished, never a second send.
      if (input.approval) {
        let mine; try { mine = requestBind({ connector: name, method, path, query: r.query, body: r.body, headers: r.headers, upload: r.upload, saveTo: r.saveTo }); } catch { mine = null; }
        if (!mine || typeof input.bind !== "string" || input.bind !== mine) throw refuse("the approval is not bound to this request");
        const id = String(input.approval).slice(0, 80), t = Date.now(), idem = input.idem ? String(input.idem) : null;
        vault.db.prepare("DELETE FROM vault_meta WHERE key LIKE 'svc-approval:%' AND CAST(json_extract(value, '$.at') AS INTEGER) < ?").run(t - APPROVAL_TTL_MS);
        const got = vault.db.prepare("INSERT INTO vault_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").run(`svc-approval:${id}`, JSON.stringify({ at: t, idem, bind: mine }));
        if (Number(got.changes) === 1) return runOnce(id);
        let prior = null; try { prior = JSON.parse(String(vault.db.prepare("SELECT value FROM vault_meta WHERE key = ?").get(`svc-approval:${id}`)?.value)); } catch { /* unreadable: spent */ }
        if (key && prior && prior.idem === idem && prior.bind === mine) {
          if (inflight.has(key)) return inflight.get(key);
          if (done.has(key)) return done.get(key).result;
        }
        throw refuse("the approval was already used");
      }
      if (key && outward) { if (done.has(key)) return done.get(key).result; if (inflight.has(key)) return inflight.get(key); }
      return runOnce(null);
    });
}
