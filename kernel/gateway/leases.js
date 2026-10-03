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
import { leasedUse } from "../seal/uses.js";

/**
 * @param {{ space: string, sealer: any, grantsStore: any, authorize: (i: any) => Promise<any>, log: any, chains: any,
 *   resolve?: (i: { space: string, ref: string, route: string }) => Promise<any>, routeAction?: (route: string) => string, session_ttl_ms?: number }} cfg
 *   resolve: the core vault's release for a credential on a route and host (the caller's; this never holds a value)
 */
export function createLeases(cfg) {
  const { sealer, grantsStore } = cfg;
  /** @type {Map<string, { member: string, device: string, device_key?: string }>} */ const info = new Map();
  /** @type {Map<string, string>} session -> lease id (the platform's mapping, bound by `bind`) */ const sessions = new Map();
  const person = (/** @type {any} */ chain) => { if (!isChain(chain) || !isExactlyPerson(chain)) throw new KernelError("chain_not_person", "a lease is a person's, on their own"); return chain.hops[0].actor; };
  const allowedFor = (/** @type {string} */ member, /** @type {string} */ device, /** @type {string | undefined} */ device_key) => { const a = typeof grantsStore.active === "function" ? grantsStore.active({ member, device, device_key }) : { spaceAllows: false, memberAccepts: false }; return a.spaceAllows === true && a.memberAccepts === true; };
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "leases", first_party: true });
  const mapErr = (/** @type {any} */ e) => (e instanceof KernelError ? e : new KernelError(typeof e?.code === "string" ? e.code : "unavailable", "the lease could not be handled"));
  const run = async (/** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { throw mapErr(e); } };

  // When access ends, the lease ends: the person whose act it was revokes it in the sealing process (it takes a person's chain).
  grantsStore.onRevoke(async (/** @type {any} */ e, /** @type {any} */ by) => {
    const devices = e.device ? [e.device] : [...new Set([...info.values()].filter(x => x.member === e.member).map(x => x.device))];
    if (!by || !isChain(by)) return;
    for (const device of devices) { try { await sealer.lease.revoke({ chain: by, space: cfg.space, device }); } catch { /* the next renewal re-checks and revokes */ } }
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
    /** Reinstating a revoked device is an admin's act, with their fresh presence proof. */
    async reinstate(chain, /** @type {{ device: string, proof: any }} */ i) {
      const p = person(chain);
      if (!grantsStore.isAdmin(p)) throw new KernelError("not_allowed", "only an owner or an admin reinstates a revoked computer");
      return run(() => sealer.lease.reinstate({ chain, device: i.device, proof: i.proof }));
    },
    /** The platform maps a session to the lease it runs under. */
    bind(/** @type {string} */ session, /** @type {string} */ id) { sessions.set(String(session), String(id)); },
    unbind(/** @type {string} */ session) { sessions.delete(String(session)); },
    /**
     * Use a credential on a route from inside a lent workspace: the session must hold a live lease, the chain must be allowed the credential's action, the vault
     * resolves it for that route per request (nothing cached), and one `vault.used` event names the use, never the value.
     */
    async use(chain, /** @type {{ ref: string, session: string, route: string }} */ i) {
      person(chain);
      if (!i || typeof i.ref !== "string" || typeof i.route !== "string" || typeof i.session !== "string") throw new KernelError("bad_input", "a use names a credential, a session and a route");
      if (!cfg.resolve) throw new KernelError("unavailable", "no vault is wired to resolve credentials");
      const action = cfg.routeAction ? cfg.routeAction(i.route) : "vault.read";
      const d = await cfg.authorize({ chain, action, resource: `vyre://${cfg.space}/credential/${encodeURIComponent(i.ref)}` });
      if (d.effect !== "allow") throw new KernelError(d.effect === "ask" ? d.reason : "not_found", "that credential is not open to this chain");
      const go = leasedUse({
        leaseOf: s => sessions.get(s) ?? null,
        check: ({ chain: c, id }) => sealer.lease.check({ chain: c, id }),
        resolve: cfg.resolve,
        emit: e => { try { cfg.log.append(kernelChain(), { type: e.type, sv: 1, subject: `vyre://${cfg.space}/credential/${encodeURIComponent(e.ref)}`, data: { device: e.device, route: e.route, session: e.session }, vis: "owner", red: "internal" }); } catch { /* a note never opens the door */ } },
        chain,
      });
      return run(() => go({ ref: i.ref, session: i.session, route: i.route }));
    },
  };
  return Object.freeze(api);
}
