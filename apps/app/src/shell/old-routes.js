// @ts-check
// The first run is one screen, /onboard (screens/first-run). This is the only place its routes and the old addresses that led to it are written: an old link, bookmark or phone link lands on the
// step it meant (the not-found routes read OLD_ROUTES), and the app's own links use FIRST_RUN so no screen spells a path of its own.

/** Where the first run opens for each of its ways in. */
export const FIRST_RUN = Object.freeze({
  start: "/onboard",
  computer: "/onboard?path=computer",
  create: "/onboard?path=create",
  join: "/onboard?path=join",
  phone: "/onboard?path=phone",
});

/** Every address the app used to have for the first run or pairing, and where it goes now. */
export const OLD_ROUTES = Object.freeze({
  "/u/install": FIRST_RUN.start,
  "/u/install/setup": FIRST_RUN.start,
  "/u/install/connect": FIRST_RUN.computer,
  "/u/install/create": FIRST_RUN.create,
  "/u/install/join": FIRST_RUN.join,
  "/u/install/phone": FIRST_RUN.phone,
  "/pair": FIRST_RUN.start,
});

/** The route an old address now means, or null for any other path. @param {string} path */
export function oldRouteTarget(path) {
  const clean = String(path || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return Object.hasOwn(OLD_ROUTES, clean) ? /** @type {Record<string, string>} */ (OLD_ROUTES)[clean] : null;
}
