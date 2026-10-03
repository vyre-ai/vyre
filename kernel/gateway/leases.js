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
import { leasedUse, credentialAction, safePath, canonicalPath } from "../seal/uses.js";

/**
 * @param {{ space: string, sealer: any, grantsStore: any, authorize: (i: any) => Promise<any>, log: any, chains: any,
 *   resolve?: (i: { space: string, ref: string, route: string }) => Promise<any>, forward?: (q: any) => Promise<any>, routeAction?: (route: string) => string, session_ttl_ms?: number }} cfg
 *   resolve: the core vault's release for a credential on a route and host (the caller's; this never holds a value)
 */
export function createLeases(cfg) {
  const { sealer, grantsStore } = cfg;
  /** @type {Map<string, { member: string, device: string, device_key?: string }>} */ const info = new Map();
  /** @type {Map<string, string>} session -> lease id (the platform's mapping, bound by `bind`) */ const sessions = new Map();
  /** @type {Map<string, { route: string, ref: string, methods: string[], paths: string[] }[]>} session -> the credentials its definition may use, held here at the home and never sent by the runner */ const defs = new Map();
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
    async issue(chain, /** @type {{ device: string, device_key?: string }} */ i) {
      const p = person(chain);
      if (!i || typeof i.device !== "string" || !i.device) throw new KernelError("bad_input", "name the computer");
      const r = await run(() => sealer.lease.issue({ chain, space: cfg.space, device: i.device, allowed: allowedFor(p.id, i.device, i.device_key) }));
      if (r && r.id) info.set(r.id, { member: p.id, device: i.device, device_key: i.device_key });
      return r;
    },
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
      const routes = [];
      for (const r of Array.isArray(def.routes) ? def.routes : []) {
        if (!r || typeof r.route !== "string" || !r.route || typeof r.ref !== "string" || !r.ref) throw new KernelError("bad_input", "a credential route names a host and a credential");
        const methods = (Array.isArray(r.methods) && r.methods.length ? r.methods : ["GET", "HEAD"]).map((/** @type {any} */ m) => String(m).toUpperCase());
        const paths = (Array.isArray(r.paths) ? r.paths : []).map(String);
        if (paths.some(x => !x.startsWith("/") || x.slice(0, -2).includes("*") || (x.includes("*") && !x.endsWith("/*")))) throw new KernelError("bad_input", "a path is exact or ends in /*");
        routes.push(Object.freeze({ route: r.route.toLowerCase(), ref: r.ref, ...(typeof r.connector === "string" ? { connector: r.connector } : {}), methods, paths }));
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
      const hit = (defs.get(i.session) || []).find(r => r.route === route && r.methods.includes(method) && r.paths.some(x => (x.endsWith("/*") ? path === x.slice(0, -2) || path.startsWith(x.slice(0, -1)) : path === x)));
      if (!hit) throw new KernelError("not_found", "that credential is not open to this session");
      const action = credentialAction("api", method);
      const d = await cfg.authorize({ chain, action, resource: `vyre://${cfg.space}/credential/${encodeURIComponent(hit.ref)}` });
      if (d.effect !== "allow") throw new KernelError(d.effect === "ask" ? d.reason : "not_found", "that credential is not open to this chain");
      const go = leasedUse({
        leaseOf: s => sessions.get(s) ?? null,
        check: ({ chain: c, id }) => sealer.lease.check({ chain: c, id }),
        resolve: cfg.resolve,
        emit: e => { try { cfg.log.append(kernelChain(), { type: e.type, sv: 1, subject: `vyre://${cfg.space}/credential/${encodeURIComponent(e.ref)}`, data: { device: e.device, route: e.route, method, path, session: e.session }, vis: "owner", red: "internal" }); } catch { /* the use already happened; the log is best effort here */ } },
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
      if (typeof i.session === "string") {
        // the lent computer's form: the session's own definition (held at the home) says which credential, never the caller
        if (typeof i.route !== "string") throw new KernelError("bad_input", "name the host");
        const hit = (defs.get(i.session) || []).find(r => r.route === i.route.toLowerCase() && r.methods.includes(method) && r.paths.some(x => (x.endsWith("/*") ? path === x.slice(0, -2) || path.startsWith(x.slice(0, -1)) : path === x)));
        if (!hit) throw new KernelError("not_found", "that request is not open to this session");
        connector = hit.connector || hit.ref; ref = hit.ref; route = hit.route;
      } else if (typeof i.connector === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(i.connector)) connector = i.connector;
      else throw new KernelError("bad_input", "name a session or a connector");
      const action = ["GET", "HEAD"].includes(method) ? "service.read" : "service.call";
      const d = await cfg.authorize({ chain, action, resource: `vyre://${cfg.space}/service/${encodeURIComponent(connector)}`, ...(i.approval ? { approval: String(i.approval) } : {}) });
      if (d.effect === "ask") return { held: true, kind: action, summary: `${method} ${connector}${path}`, decision: d.decision };
      if (d.effect !== "allow") throw new KernelError("not_found", "that request is not open to this caller");
      const files = [[i.upload && i.upload.drive && i.upload.drive.path, "drive.read"], [i.saveTo, "drive.write"]];
      for (const [fp, act] of files) {
        if (typeof fp !== "string") continue;
        let u; try { u = `vyre://${cfg.space}/file/${safePath(fp)}`; } catch { throw new KernelError("not_found", "that file is not open to this caller"); }
        if ((await cfg.authorize({ chain, action: act, resource: u })).effect !== "allow") throw new KernelError("not_found", "that file is not open to this caller");
      }
      const r = await run(() => cfg.forward({ space: cfg.space, connector, ...(ref ? { ref, route } : {}), request: { method, path, ...(i.query ? { query: i.query } : {}), ...(i.headers ? { headers: i.headers } : {}), ...(i.body !== undefined ? { body: i.body } : {}), ...(i.upload ? { upload: i.upload } : {}), ...(i.saveTo ? { saveTo: i.saveTo } : {}) }, ...(typeof i.session === "string" ? { session: i.session } : {}), ...(i.idem ? { idem: String(i.idem) } : {}), ...(i.approval ? { approval: String(i.approval) } : {}) }));
      try { cfg.log.append(kernelChain(), { type: "vault.forwarded", sv: 1, subject: `vyre://${cfg.space}/service/${encodeURIComponent(connector)}`, data: { method, path, status: r && r.status !== undefined ? r.status : null, ...(typeof i.session === "string" ? { session: i.session } : {}) }, vis: "owner", red: "internal" }); } catch { /* the call was made; the log is best effort here */ }
      return r;
    },
  };
  return Object.freeze(api);
}
