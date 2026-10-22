// @ts-check
// The first page for each role. The Space's setting (spaces.landing) holds a route per role, and a
// person opens the one for their role when they sign in to that Space. A role with no page of its
// own opens Home.
//
// The role is the key the server sends (the person-facing one: owner, admin, member, guest), so the
// app never carries the role list nor the kernel behind it. Pure, so Node tests it; the shell reads
// it (screens/shell/UiShell.tsx).

/** Where a person opens when their role has no page of its own. */
export const HOME = "/u/now";

/**
 * The page for a role, or null: no page set, no role, or a page that is not one of the app's own.
 * @param {any} value the setting's value
 * @param {string} key the role's key, as the server sends it (the person-facing one)
 * @returns {string | null}
 */
export function landingRoute(value, key) {
  if (!key || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value[key];
  if (typeof route !== "string" || !route.startsWith("/u/") || route.includes("..")) return null;
  return route;
}

/**
 * Should the app replace the route with the first page now? Only at the start: the person has not
 * moved yet, and the app is on the page it opens on. A route they chose is never taken away.
 * @param {{ path: string, landing: string | null, moved: boolean }} o
 * @returns {boolean}
 */
export function shouldLand({ path, landing, moved }) {
  if (moved || !landing) return false;
  return path === HOME;
}
