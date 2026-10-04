// @ts-check
// The first-run gate. A phone with no paired server has nothing to show: every route but setup (and the two links that finish a pairing) goes to the install flow.
// Pure, so Node tests it; src/shell/SetupGate.tsx reads the pairing and calls this.

/** Routes that stay reachable with no server: the install flow itself, a pairing link and a join link. */
export const OPEN_ROUTES = /^\/(u\/install|pair|join)(\/|$)/;

/** Where an unpaired phone goes. */
export const SETUP_ROUTE = "/u/install";

/**
 * Where the gate sends this path, or null to let it stay.
 * @param {{ path: string, paired: boolean, direct: boolean }} o `direct`: the box's address is configured (a dev or web build), which needs no pairing
 * @returns {string | null}
 */
export function gateTarget({ path, paired, direct }) {
  if (paired || direct) return null;
  return OPEN_ROUTES.test(path) ? null : SETUP_ROUTE;
}
