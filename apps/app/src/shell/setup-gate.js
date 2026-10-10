// @ts-check
// The first-run gate. A phone with no paired server has nothing to show: every route but setup (and the two links that finish a pairing) goes to the install flow.
// "Not now" on "I don't have Vyre running yet" is the one way out: it keeps the new UI's own landing ("Not connected to a Vyre", with its Scan the code action) and nothing else.
// Pure, so Node tests it; src/shell/SetupGate.tsx reads the pairing and calls this.

/** Routes that stay reachable with no server: the install flow itself, a pairing link and a join link, and the sample-world proof page for the Glass relay path (a mock build only: it draws nothing in a real one). */
export const OPEN_ROUTES = /^\/(u\/install|pair|join|glass-relay-proof)(\/|$)/;

/** Where an unpaired phone goes. */
export const SETUP_ROUTE = "/u/install";
/** Where a phone that chose "Not now" goes: the landing that says it is not connected. */
export const LANDING_ROUTE = "/u/now";

/**
 * Where the gate sends this path, or null to let it stay.
 * @param {{ path: string, paired: boolean, direct: boolean, skipped?: boolean }} o `direct`: the box's address is configured (a dev or web build), which needs no pairing; `skipped`: the person chose "Not now"
 * @returns {string | null}
 */
export function gateTarget({ path, paired, direct, skipped = false }) {
  if (paired || direct) return null;
  if (OPEN_ROUTES.test(path)) return null;
  if (skipped) return /^\/u(\/|$)/.test(path) ? null : LANDING_ROUTE;
  return SETUP_ROUTE;
}
