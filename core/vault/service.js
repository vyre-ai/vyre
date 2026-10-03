// @ts-check
// core/vault/service.js: a Flow's "Call a service" (sessions' port, kernel/gateway/leases.js forward, connector form). The Flow names a CONNECTOR (an api-credential in this vault)
// and a method and path; it never holds a URL, host or key. What a Flow may reach through a connector is the credential's own `service` rules, `{ allow, deny }`, written by a
// person with the credential: deny wins, the default is no, and a credential with no `service` is not a connector at all. The kernel has already authorized the caller's chain
// (`service.read` or `service.call`, and the Drive paths a file moves); this adds the connector's own rules, then the same checks as every vault request (hosts, the SSRF guard,
// read or outward). Two internal tools, callable only by the kernel's lease module: `vault.service.catalog` (the rules, never a secret or a host) and `vault.service.forward`.

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

/** Deny wins, default no. @param {{ allow?: any[], deny?: any[] } | undefined} rules */
export function routeAllowed(rules, method, pathname) {
  if (!rules) return false;
  const hit = list => (list || []).some(r => (!r.method || r.method === "*" || r.method === method) && pathMatches(r.path, pathname));
  return hit(rules.allow) && !hit(rules.deny);
}

/** @param {ReturnType<typeof import("./request.js").ApiRequests.prototype.constructor>} _ */
export function registerService({ api, vault, internal, forwardFile, obj, str }) {
  /** idem key -> { at, result }: an outward call made once per `<run>:<step>`, so a retry after a crash returns the first answer instead of sending again. In memory: a restart forgets it, and the ask-first approval still guards the act. */
  const done = new Map();
  const remember = (k, result) => {
    const t = Date.now();
    for (const [x, v] of done) if (v.at < t - IDEM_TTL_MS) done.delete(x);
    if (done.size >= IDEM_MAX) done.delete(done.keys().next().value);
    done.set(k, { at: t, result });
  };
  /** approval id -> the request it was spent on (SV-2): single use, and only for the request the held decision bound it to. In memory; a restart forgets, and the kernel's own approval still expires. */
  const spent = new Map();
  const callerOk = c => c === "kernel:leases" || c === "module:leases";

  internal("vault.service.catalog", "The connectors a Flow may call: { connectors: { <name>: { allow: [{ method?, path }], deny: [{ method?, path }] } } }, the credential's own `service` rules. No host, no secret. Only the kernel's lease module asks.",
    obj({}, []),
    async (_input, { caller }) => {
      if (!callerOk(String(caller))) throw bad("only the kernel's lease module reads the connector list", "denied");
      const connectors = {};
      for (const name of await vault.apiCredentialNames()) {
        try { const { config } = await vault.apiCredential(name); if (config.service) connectors[name] = { allow: config.service.allow, deny: config.service.deny }; } catch { /* not readable: not a connector */ }
      }
      return { connectors };
    });

  internal("vault.service.forward", "A Flow's call through a connector: { connector, request: { method, path, query?, headers?, body?, upload?, saveTo? }, idem?, approval? }. Refused unless the connector's `service` rules allow the method and path. Returns { status, ok, headers, body (base64) }, or { saved } for a Drive save, or { held } when the vault itself must ask. Only the kernel's lease module calls it, after authorizing the caller's chain; `approval` is an ask-first task id the kernel has already seen approved.",
    obj({ connector: str, request: { type: "object" }, idem: str, approval: str }, ["connector", "request"]),
    async (input, { caller }) => {
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
      const host = config.hosts.find(h => !h.startsWith("*."));
      if (!host) throw bad("this connector names no exact host, so a Flow cannot reach it", "not_found");
      // SV-2: an approval releases ONE request. The held decision carried `bind` (connector, method, canonical path, query, body hash); the retry must pass it back, the vault recomputes it
      // from what it is about to send, and an approval id is spent once (a replay of the same idem returns the first answer below).
      let approval = null;
      if (input.approval) {
        let mine; try { mine = requestBind({ connector: name, method, path, query: r.query, body: r.body }); } catch { mine = null; }
        const id = String(input.approval).slice(0, 80), t = Date.now();
        for (const [k, v] of spent) if (v.at < t - APPROVAL_TTL_MS) spent.delete(k);
        if (!mine || typeof input.bind !== "string" || input.bind !== mine) { audit(false, `${method} refused: the approval is not bound to this request`); throw bad("that request is not open to this caller", "not_found"); }
        const prior = spent.get(id);
        if (prior && !(input.idem && prior.idem === String(input.idem))) { audit(false, `${method} refused: the approval was already used`); throw bad("that request is not open to this caller", "not_found"); }
        if (!prior) spent.set(id, { at: t, idem: input.idem ? String(input.idem) : null, bind: mine });
        approval = id;
      }
      const key = input.idem ? `${name}\0${String(input.idem)}` : null;
      if (key && done.has(key) && method !== "GET" && method !== "HEAD") return done.get(key).result;
      const base = { credential: name, method, url: `https://${host}${path}`, ...(r.query ? { query: r.query } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(r.body !== undefined ? { body: r.body } : {}) };
      const who = `flow:${String(input.idem || "run").slice(0, 80)}`;
      let out;
      if (r.upload || r.saveTo) {
        if (!api.deps.files) throw bad("the Drive is not wired to this vault", "unavailable");
        // Drive paths get the same one-form refusal as request paths (dot segments, backslash, encoded slash, control characters, empty segments): `/Clients/A/../B/x` must not pass as under `Clients/A`.
        const fileRefused = () => bad("that file is not open to this caller", "not_found");
        const dp = x => { try { return safePath(String(x)); } catch { throw fileRefused(); } };
        if (r.upload?.drive?.path !== undefined) r.upload.drive.path = dp(r.upload.drive.path);
        if (Array.isArray(r.upload?.multipart)) for (const p of r.upload.multipart) if (p && p.drive && p.drive.path !== undefined) p.drive.path = dp(p.drive.path);
        if (r.saveTo !== undefined) r.saveTo = dp(r.saveTo);
        const drive = { read: [r.upload?.drive?.path, ...(Array.isArray(r.upload?.multipart) ? r.upload.multipart.map(p => p?.drive?.path) : [])].filter(x => typeof x === "string"), write: r.saveTo ? [String(r.saveTo)] : [] };
        const x = await forwardFile(api, { files: api.deps.files }, { ...base, ...(r.upload ? { upload: r.upload } : {}), ...(r.saveTo ? { saveTo: r.saveTo } : {}), drive }, { caller: who });
        out = x.held ? x : { ...x, ...(x.body ? { body: x.body.toString("base64") } : {}) };
      } else if (approval && method !== "GET" && method !== "HEAD") {
        // The kernel saw the ask-first task approved, so the person is asked once: run exactly this request, re-checked, with the approval named in the audit row.
        const plan = await api.plan({ ...base, headers: (await import("./request.js")).forwardHeaders(r.headers) }, name);
        const x = await api.execute(plan, { who, released: approval, raw: true });
        out = { ...x, body: x.body.toString("base64"), kind: plan.kind };
      } else {
        const x = await api.forward(base, { caller: who });
        out = x.held ? x : { ...x, body: x.body.toString("base64") };
      }
      if (key && !out.held) remember(key, out);
      return out;
    });
}
