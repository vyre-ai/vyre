// @ts-check
// The home's end of a lent computer, for each Space this home serves (core/runner/lent-home.js): a member's computer runs one of the Space's sessions and checkpoints it here.
// The peer door registers the result as the remote server's `lent` service. The Space's definition of a session comes from `lentSpec` (the daemon's option); without one the home answers
// "the Space has no definition for that session" (not_found) rather than inventing a program to run on someone's computer.
import path from "node:path";
import { createLentHome } from "../runner/lent-home.js";

/**
 * @param {{ root: string, lentSpec?: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any }} o
 * @returns {(space: string, kernel: any) => any}
 */
export function lentServiceFor(o) {
  return (space, k) => {
    const g = k && k.gateway;
    if (!g || !g.grants || !g.grants.offers) return null;
    return createLentHome({ space, root: path.join(o.root, "lent", space), offers: g.grants.offers, ...(g.leases ? { leases: g.leases } : {}),
      specFor: async i => (o.lentSpec ? o.lentSpec(i) : null) });
  };
}
