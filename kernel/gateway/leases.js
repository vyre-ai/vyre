// kernel/gateway/leases.js: the kernel's side of key leases for a lent computer's workspace (vault's kernel/seal/leases.js holds the keys and the memory;
// DESIGN-local-runner.md section 3). The kernel supplies what the sealing process must not decide for itself:
//   - `allowed`: computed here from the Offers (`offers.active`: the Space allows its work on this member's computer AND the member accepts it), on every issue
//     and renew, never taken from the caller;
//   - revocation: when either Offer is withdrawn, or the member's role changes or the member is removed, the lease for that member's computer(s) is revoked at
//     once (through the person whose act it was), so the runner learns on its next renewal or immediately;
//   - reinstating a revoked device is an admin-only act with the admin's fresh presence proof (the process checks the proof; this checks the role first);
//   - credential use by route: a session holds a live lease, the vault resolves the credential for that route per request, nothing is cached, and one event
//     says it was used, never the value.
// Every call takes a kernel-built chain that is exactly one person (the process also refuses a model's chain).
import { isChain, isExactlyPerson } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { helloOf } from "../remote/proof.js";
import { credentialUrn } from "../contracts/index.js";
import { leasedUse, credentialAction, safePath, canonicalPath, requestBind, normalizeRoute, routeAllows } from "../seal/uses.js";

/**
 * @param {{ space: string, sealer: any, grantsStore: any, authorize: (i: any) => Promise<any>, log: any, chains: any,
 *   enforce?: (chain: any, d: any) => void, drive?: any,
 *   resolve?: (i: { space: string, ref: string, route: string }) => Promise<any>, forward?: (q: any) => Promise<any>, routeAction?: (route: string) => string, session_ttl_ms?: number }} cfg
 *   resolve: the core vault's release for a credential on a route and host (the caller's; this never holds a value)
 */
/** What a model-provider route may do without a grant: ask a model, count tokens, list models. Nothing here changes anything at the provider. */
const INFERENCE = Object.freeze([{ method: "POST", path: "/v1/messages" }, { method: "POST", path: "/v1/messages/count_tokens" }, { method: "GET", path: "/v1/models" }]);

/** The tighter of two network limits ("provider" is tighter than "internet", none stated is the loosest). @param {...(string | null | undefined)} caps */
const tightestCap = (...caps) => caps.reduce((a, c) => (c === "provider" || a === "provider" ? "provider" : c === "internet" || a === "internet" ? "internet" : null), /** @type {string | null} */ (null));

export function createLeases(cfg) {
  const { sealer, grantsStore } = cfg;
  /** @type {Map<string, { member: string, device: string, device_key?: string, hello?: any }>} */ const info = new Map();
  /** @type {Map<string, string>} session -> lease id (the platform's mapping, bound by `bind`) */ const sessions = new Map();
  /** @type {Map<string, any[]>} session -> the credentials its definition may use, held here at the home and never sent by the runner */ const defs = new Map();
  const person = (/** @type {any} */ chain) => { if (!isChain(chain) || !isExactlyPerson(chain)) throw new KernelError("chain_not_person", "a lease is a person's, on their own"); return chain.hops[0].actor; };
  const allowedFor = (/** @type {string} */ member, /** @type {string} */ device, /** @type {string | undefined} */ device_key) => { const a = typeof grantsStore.active === "function" ? grantsStore.active({ member, device, device_key }) : { spaceAllows: false, memberAccepts: false }; return a.spaceAllows === true && a.memberAccepts === true; };
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "leases", first_party: true });
  const mapErr = (/** @type {any} */ e) => (e instanceof KernelError ? e : new KernelError(typeof e?.code === "string" ? e.code : "unavailable", "the lease could not be handled"));
  const run = async (/** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { throw mapErr(e); } };

  // When access ends, the lease ends: the person whose act it was revokes it in the sealing process (it takes a person's chain).
  grantsStore.onRevoke(async (/** @type {any} */ e, /** @type {any} */ by) => {
    const devices = e.device ? [e.device] : [...new Set([...info.values()].filter(x => x.member === e.member).map(x => x.device))];
    if (!by || !isChain(by)) return;
    for (const device of devices) { try { await sealer.lease.revoke({ chain: by, space: cfg.space, member: e.member, device }); } catch { /* the next renewal re-checks and revokes */ } }
    for (const [id, x] of [...info]) if (x.member === e.member && (!e.device || x.device === e.device)) info.delete(id);
  });

  const api = {
    /** The key that opens this device's workspace for this Space, while both Offers hold. */
    async issue(chain, /** @type {{ device: string, device_key?: string, hello?: any, proof?: any }} */ i) {
      const p = person(chain);
      if (!i || typeof i.device !== "string" || !i.device) throw new KernelError("bad_input", "name the computer");
      // R031-95 2.2 (ruled 10 Oct): the member's lend IS the permit. The home checks it, not a signature: both Offers must stand for exactly this computer and key (`allowed`, below, from the Offers on every issue and every
      // renewal), so a request from another computer, after an unlend, a revoke or a removal, is answered "revoked" and gets no key. What the computer says about itself in its hello (its limit, runner version, protocol) are
      // claims that can only tighten: the home takes the tightest of them, the Offers and the floor, and never a looser one. Every request, granted or refused, is on the log.
      const hello = helloOf(i);
      if (hello && (hello.device !== i.device || hello.device_key !== (i.device_key ?? i.device))) throw new KernelError("bad_input", "the request names another computer");
      // A computer asks for its OWN lease: the device the transport proved is the one the request names. Another of the member's computers, or their phone, naming it gets nothing. (A probe, `probe: true`, only asks
      // whether this member's computer was removed before; it is answered yes or no and never holds a key.)
      const via = chain.hops[0] && chain.hops[0].via, proven = via && typeof via.device === "string" && via.device ? via.device.replace(/^device:/, "") : null;
      const probe = i.probe === true;
      const refuse = (/** @type {string} */ why) => { try { cfg.log.append(kernelChain(), { type: "lease.refused", sv: 1, subject: `vyre://${cfg.space}/lease/${i.device}`, data: { member: p.id, device: i.device, why }, vis: "owner", red: "internal" }); } catch { /* best effort */ } };
      if (proven && proven !== i.device && !probe) { refuse("another_computer"); throw new KernelError("not_allowed", "a computer asks for its own lease"); }
      const allowed = allowedFor(p.id, i.device, i.device_key);
      const r = await run(() => sealer.lease.issue({ chain, space: cfg.space, device: i.device, allowed }));
      if (probe) return { revoked: Boolean(r && r.revoked) };
      const limit = tightestCap(typeof grantsStore.capOf === "function" ? grantsStore.capOf({ member: p.id, device: i.device }) : null, hello && hello.cap);
      try { cfg.log.append(kernelChain(), { type: r && r.id ? "lease.issued" : "lease.refused", sv: 1, subject: `vyre://${cfg.space}/lease/${i.device}`, data: { member: p.id, device: i.device, limit, ...(r && r.id ? {} : { why: "no_lend" }), ...(hello ? { runner_version: hello.runner_version, protocol: hello.protocol } : {}) }, vis: "owner", red: "internal" }); } catch { /* the lease is the answer; the log is best effort here */ }
      if (r && r.id) info.set(r.id, { member: p.id, device: i.device, device_key: i.device_key, ...(hello ? { hello } : {}) });
      return r;
    },
    /** What the computer said when it asked for this lease (its limit, runner and protocol), or null: the home reads the lender's claimed limit from here, and only ever tightens with it. */
    helloOf(/** @type {string} */ id) { const l = info.get(String(id)); return l && l.hello ? l.hello : null; },
    /** Renewal re-checks the Offers every time; a lease that is not this person's is unknown. */
    async renew(chain, /** @type {{ id: string }} */ i) {
      const p = person(chain);
      const l = info.get(i.id);
      if (!l || l.member !== p.id) throw new KernelError("unknown_lease", "no such lease");
      return run(() => sealer.lease.renew({ chain, id: i.id, allowed: allowedFor(l.member, l.device, l.device_key) }));
    },
    /** Revoke a member's lease on a computer: only that member, or an owner or an admin, may; another member naming the same device id cannot (L-5). */
    async revoke(chain, /** @type {{ member: string, device: string }} */ i) {
      const p = person(chain);
      if (p.id !== i.member && !grantsStore.isAdmin(p)) throw new KernelError("not_allowed", "only that member, or an owner or an admin, revokes a computer's lease");
      for (const [id, x] of [...info]) if (x.member === i.member && x.device === i.device) info.delete(id);
      return run(() => sealer.lease.revoke({ chain, space: cfg.space, member: i.member, device: i.device }));
    },
    /** Reinstating a revoked device is an admin's act, with their fresh presence proof, for that member's computer. */
    async reinstate(chain, /** @type {{ member: string, device: string, proof: any }} */ i) {
      const p = person(chain);
      if (!grantsStore.isAdmin(p)) throw new KernelError("not_allowed", "only an owner or an admin reinstates a revoked computer");
      return run(() => sealer.lease.reinstate({ chain, member: i.member, device: i.device, proof: i.proof }));
    },
    /**
     * The platform maps a session to the lease it runs under AND to what its definition lets it use: `routes` is `[{ route (host), ref, methods?, paths? }]`, set at
     * the home from the session's or tool's definition. A session bound without routes can use no credential. `methods` default to GET and HEAD; `paths` are exact or
     * end in `/*`, and have no default (a route with no paths matches nothing).
     */
    bind(/** @type {string} */ session, /** @type {string} */ id, /** @type {{ routes?: any[] }} */ def = {}) {
      // LF-3: the route record the Space holds, whole: allow and deny lists (deny wins), the size cap, the content types, the Drive lists and the header names the program may send.
      // `methods` and `paths` stay as the older shorthand (every listed method on every listed path; GET and HEAD by default). A route with no path matches nothing.
      const routes = [];
      for (const r of Array.isArray(def.routes) ? def.routes : []) {
        try { routes.push(Object.freeze({ ...normalizeRoute(r), ...(typeof r.connector === "string" ? { connector: r.connector } : {}), ...(r.provider === true ? { provider: true } : {}) })); } catch { throw new KernelError("bad_input", "a credential route names a host and a credential, and its lists are exact paths or end in /*"); }
      }
      sessions.set(String(session), String(id));
      defs.set(String(session), routes);
    },
    unbind(/** @type {string} */ session) { sessions.delete(String(session)); defs.delete(String(session)); },
    /**
     * Use a credential for one request from inside a lent workspace. The runner names only the session and the request (host, method, path); the credential is looked
     * up here from the session's definition, and a request the definition does not map is refused as absent. A GET or HEAD is a read; any other method is an outward
     * call (`vault.call`) and goes through the outward check, so it asks. The session must hold a live lease, the vault resolves per request (nothing cached), and one
     * `vault.used` event names the use (host, method, path), never the value.
     */
    async use(chain, /** @type {{ session: string, route: string, method: string, path: string }} */ i) {
      person(chain);
      if (!i || typeof i.route !== "string" || typeof i.session !== "string" || typeof i.method !== "string" || typeof i.path !== "string") throw new KernelError("bad_input", "a use names a session, a host, a method and a path");
      if (!cfg.resolve) throw new KernelError("unavailable", "no vault is wired to resolve credentials");
      const method = i.method.toUpperCase(), route = i.route.toLowerCase();
      let path;
      try { path = canonicalPath(i.path.split(/[?#]/)[0]); } catch { throw new KernelError("not_found", "that credential is not open to this session"); }
      const hit = (defs.get(i.session) || []).find(r => r.route === route && routeAllows(r, method, path));
      if (!hit) throw new KernelError("not_found", "that credential is not open to this session");
      // A model-provider route (`provider: true`, set only by the home's own definition of the member's session, never by a caller) may carry inference, which is a POST that changes nothing at the provider:
      // the lease only exists while both Offers stand (the person's yes, with presence), and these three calls are all it may make. Every other route, and every other call on this one, is authorized by the
      // kernel's grants as before: a write method asks.
      if (!(hit.provider && INFERENCE.some(a => a.method === method && (a.path === path)))) {
        const action = credentialAction("api", method);
        const d = await cfg.authorize({ chain, action, resource: credentialUrn(cfg.space, hit.ref) });
        if (d.effect !== "allow") throw new KernelError(d.effect === "ask" ? d.reason : "not_found", "that credential is not open to this chain");
        if (cfg.enforce) cfg.enforce(chain, d);
      }
      const go = leasedUse({
        leaseOf: s => sessions.get(s) ?? null,
        check: ({ chain: c, id }) => sealer.lease.check({ chain: c, id }),
        resolve: cfg.resolve,
        emit: e => { try { cfg.log.append(kernelChain(), { type: e.type, sv: 1, subject: credentialUrn(cfg.space, e.ref), data: { device: e.device, route: e.route, method, path, session: e.session }, vis: "owner", red: "internal" }); } catch { /* the use already happened; the log is best effort here */ } },
        chain,
      });
      return run(() => go({ ref: hit.ref, session: i.session, route, method, path }));
    },
    /**
     * A credentialed request run at the home: the vault does it with the Space's own credential and the caller gets only the response (no secret ever leaves). Authorized HERE, before the
     * vault is asked, for the CALLER's chain against the route: `service.read` for a GET or HEAD, `service.call` (outward: it asks) for anything else, on
     * `vyre://<space>/service/<connector>`; a Drive file it reads or saves is `drive.read` or `drive.write` for the same chain, so the route's lists narrow what the caller may already do and
     * never widen it (reviewer-2 FW-2). Two forms: a lent computer's session (`{ session, route, method, path }`, the credential and routes come from the Space's own session definition
     * (`bind`), never from the caller: FW-3), and a named connector (`{ connector, method, path }`, a Flow's "Call a service"). The chain may be a person's or a Flow run's (a job under its
     * approver): what authorizes it is the grants, not the shape. A request the kernel says must ask comes back as `{ held }` and nothing is sent; an approved held act passes `approval`.
     */
    async forward(chain, /** @type {any} */ i) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!cfg.forward) throw new KernelError("unavailable", "no vault is wired to forward requests");
      if (!i || typeof i.method !== "string" || typeof i.path !== "string" || !i.path.startsWith("/")) throw new KernelError("bad_input", "a forward names a method and a path");
      const method = i.method.toUpperCase();
      let path;
      try { path = canonicalPath(i.path.split(/[?#]/)[0]); } catch { throw new KernelError("not_found", "that request is not open to this caller"); }
      /** @type {string} */ let connector, ref = null, route = null;
      /** @type {any} */ let def = null;
      if (typeof i.session === "string") {
        // the lent computer's form: the session's own definition (held at the home) says which credential, never the caller
        if (typeof i.route !== "string") throw new KernelError("bad_input", "name the host");
        const hit = (defs.get(i.session) || []).find(r => r.route === i.route.toLowerCase() && routeAllows(r, method, path));
        if (!hit) throw new KernelError("not_found", "that request is not open to this session");
        connector = hit.connector || hit.ref; ref = hit.ref; route = hit.route; def = hit;
      } else if (typeof i.connector === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(i.connector)) connector = i.connector;
      else throw new KernelError("bad_input", "name a session or a connector");
      const action = ["GET", "HEAD"].includes(method) ? "service.read" : "service.call";
      // LF-1: everything is decided first (the service, then each Drive file), and only when ALL allow is each decision counted through `enforce`, which is what applies a grant's
      // rate, budget (meter) and once. A request refused anywhere counts nothing; a request that goes ahead is counted exactly once per decision, like any gated act.
      const d = await cfg.authorize({ chain, action, resource: `vyre://${cfg.space}/service/${encodeURIComponent(connector)}`, ...(i.approval ? { approval: String(i.approval), bind: requestBind({ connector, method, path, query: i.query, body: i.body, headers: i.headers, upload: i.upload, saveTo: i.saveTo }) } : {}) });
      if (d.effect === "ask") return { held: true, kind: action, summary: `${method} ${connector}${path}`, decision: d.decision, bind: requestBind({ connector, method, path, query: i.query, body: i.body, headers: i.headers, upload: i.upload, saveTo: i.saveTo }) };
      if (d.effect !== "allow") throw new KernelError("not_found", "that request is not open to this caller");
      const decisions = [d];
      const file = i.upload !== undefined || i.saveTo !== undefined || i.stream === true;
      const files = [[i.upload && i.upload.drive && i.upload.drive.path, "drive.read"], [i.saveTo, "drive.write"]];
      if (Array.isArray(i.upload && i.upload.multipart)) for (const p of i.upload.multipart) if (p && p.drive) files.push([p.drive.path, "drive.read"]);
      for (const [fp, act] of files) {
        if (typeof fp !== "string") continue;
        let u; try { u = `vyre://${cfg.space}/file/${safePath(fp)}`; } catch { throw new KernelError("not_found", "that file is not open to this caller"); }
        const fd = await cfg.authorize({ chain, action: act, resource: u });
        if (fd.effect !== "allow") throw new KernelError("not_found", "that file is not open to this caller");
        decisions.push(fd);
      }
      if (cfg.enforce) for (const x of decisions) cfg.enforce(chain, x);
      // LF-3: the route record's limits travel with the request (size cap, content types, Drive lists, header names), and the Drive is this chain's own door (FW-2), never the home's.
      const limits = def ? { allow_headers: def.headers, limits: { maxBytes: def.maxBytes, contentTypes: def.contentTypes }, drive: def.drive } : {};
      if (file && !cfg.drive) throw new KernelError("unavailable", "no Drive is wired to forward a file");
      const r = await run(() => cfg.forward({ space: cfg.space, connector, ...limits, ...(file ? { file: true, files: cfg.drive.files(chain) } : {}), ...(ref ? { ref, route } : {}), request: { method, path, ...(i.query ? { query: i.query } : {}), ...(i.headers ? { headers: i.headers } : {}), ...(i.body !== undefined ? { body: i.body } : {}), ...(i.upload ? { upload: i.upload } : {}), ...(i.saveTo ? { saveTo: i.saveTo } : {}) }, ...(typeof i.session === "string" ? { session: i.session } : {}), ...(i.idem ? { idem: String(i.idem) } : {}), ...(i.approval ? { approval: String(i.approval) } : {}), ...(i.bind ? { bind: String(i.bind) } : {}) }));
      try { cfg.log.append(kernelChain(), { type: "vault.forwarded", sv: 1, subject: `vyre://${cfg.space}/service/${encodeURIComponent(connector)}`, data: { method, path, status: r && r.status !== undefined ? r.status : null, ...(typeof i.session === "string" ? { session: i.session } : {}) }, vis: "owner", red: "internal" }); } catch { /* the call was made; the log is best effort here */ }
      return r;
    },
  };
  return Object.freeze(api);
}
