// @ts-check
// The home's end of a lent computer, for each Space this home serves (core/runner/lent-home.js): a member's computer runs one of the Space's sessions and checkpoints it here.
// The peer door registers the result as the remote server's `lent` service. A lent session is the member's OWN session for the Space, run on their computer instead of the server: the Space's definition of it
// is the agent the member runs (the same program a session on the server would start, named, not a path: the lender finds it on its own computer), with the provider as its only network. `lentSpec` (the daemon's
// option) replaces the definition; `VYRE_LENT_AGENT` names another agent program on a development build.
import path from "node:path";
import { createLentHome } from "../runner/lent-home.js";

/** The Space's definition of a member's own session: the agent by name, the provider as the only network, no credential route until the Space maps one (the vault answers per request, never the lender). */
const defaultSpec = () => ({ command: process.env.VYRE_LENT_AGENT || "claude", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] });

/**
 * `onRevoke(space, { device, member, side, reason })` is told when an Offer for a computer of this Space ends (withdrawn, the member removed or left): the daemon tells that computer down the connection it holds.
 * @param {{ root: string, lentSpec?: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any, onRevoke?: (space: string, info: any) => void }} o
 * @returns {(space: string, kernel: any) => any}
 */
export function lentServiceFor(o) {
  /** @type {Map<string, () => void>} */ const subs = new Map();
  return (space, k) => {
    const g = k && k.gateway;
    if (!g || !g.grants || !g.grants.offers) return null;
    if (o.onRevoke && typeof g.grants.offers.onRevoke === "function") {
      if (subs.has(space)) { try { subs.get(space)?.(); } catch { /* gone */ } }
      subs.set(space, g.grants.offers.onRevoke((/** @type {any} */ info) => { if (info && info.device) o.onRevoke?.(space, info); }));
    }
    return createLentHome({ space, root: path.join(o.root, "lent", space), offers: g.grants.offers, ...(g.leases ? { leases: g.leases } : {}),
      specFor: async i => (o.lentSpec ? o.lentSpec(i) : defaultSpec()) });
  };
}
