// kernel/gateway/runner-ports.js: the runner's ports, built from the kernel's own pieces (`ctx.kernel.runnerPorts(...)`). The shape is the runner's (core/runner/ports.js
// on its branch), but where the runner asked its caller to say `allowed`, the kernel computes it: the lease is issued and renewed through `gateway.leases`, which asks
// the two Offers itself, binds the lease to the computer's key and the member, and revokes it the moment either Offer is withdrawn. The runner is told at once
// through `onRevoke`. Every call runs under the person's chain (from the Surfaces door); the runner never builds one.
import { KernelError } from "../core/errors.js";

/**
 * @param {{ leases: any, offers: any }} k the gateway's `leases` and `grants.offers`
 * @param {{ chain: () => any, member: string, deviceId: () => string, deviceKey: () => string, sync?: any, spec?: any, server?: any, requestServer?: any,
 *   labels?: any, sealState?: any, verifyState?: any, sessionState?: any }} o chain: the person's chain for this call (a function, so it is minted fresh each time)
 */
export function runnerPorts(k, o) {
  if (!k.leases) throw new KernelError("unavailable", "leases are not wired (the kernel needs the sealing process and its own grants store)");
  const device = o.deviceId(), device_key = o.deviceKey();
  if (!device || typeof device !== "string" || !device_key || typeof device_key !== "string") throw new KernelError("bad_input", "the runner needs this computer's device identity and key");
  const active = () => k.offers.active({ member: o.member, device, device_key });
  return {
    device,
    vault: {
      lease: (/** @type {{ space?: string }} */ _a) => k.leases.issue(o.chain(), { device, device_key }),
      renew: (/** @type {{ id: string }} */ a) => k.leases.renew(o.chain(), { id: a.id }),
      // The runner names the session and the request only; the Space maps it to a credential (leases.bind) and refuses what the session's definition does not map.
      credential: (/** @type {{ session: string, route: string, method: string, path: string }} */ req) => k.leases.use(o.chain(), { session: req.session, route: req.route, method: req.method, path: req.path }),
    },
    sync: o.sync,
    grants: () => active(),
    onRevoke: (/** @type {(e: any) => void} */ fn) => k.offers.onRevoke((/** @type {any} */ info) => { if (!info || !info.device || info.device === device) return fn(info); }),
    spec: o.spec, server: o.server, requestServer: o.requestServer,
    labels: o.labels, sealState: o.sealState, verifyState: o.verifyState, sessionState: o.sessionState,
  };
}
