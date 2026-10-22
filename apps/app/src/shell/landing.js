// @ts-check
// The first page for each role. The Space's setting (spaces.landing) holds a route per role, and a
// person opens the one for their role when they sign in to that Space. A role with no page of its
// own opens Home.
//
// The role is the kernel's id; the setting's keys are the ones a person sees, so the catalogue maps
// one to the other (the kernel's temp is the guest). Pure, so Node tests it; the shell reads it
// (screens/shell/UiShell.tsx).
import { BUILTIN_VIEW } from "../../../../lib/roles/catalogue.js";

/** Where a person opens when their role has no page of its own. */
export const HOME = "/u/now";

/** The role ids a page may be set for, in the catalogue's order. */
export const ROLE_IDS = Object.freeze(BUILTIN_VIEW.map((r) => r.id));

/** The setting key for a kernel role: the kernel's temp is the person-facing guest. */
const KEY_OF = new Map(BUILTIN_VIEW.map((r) => [r.kernel, r.id]));

/**
 * The page for a role, or null: no page set, a role with no key of its own, or a page that is not
 * one of the app's own.
 * @param {any} value the setting's value
 * @param {string} role the kernel's role for this person
 * @returns {string | null}
 */
export function landingRoute(value, role) {
  const key = KEY_OF.get(String(role || ""));
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
