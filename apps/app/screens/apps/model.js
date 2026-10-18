// @ts-check
// The Apps place: one tile per app this Space has (an app is a module that declares screens), each opening its first screen. Pure, so Node tests it.
import { moduleHref } from "../../../../lib/sidebar/model.js";

/** @typedef {{ module: string, label?: string, screens: { id: string, label: string, path?: string, icon?: string, view?: boolean }[] }} ModuleScreens */

/** A module name read as a title: "documents" -> "Documents", "pdf-converter" -> "Pdf converter". @param {string} name */
export const titleOf = name => { const t = String(name || "").replace(/[-_]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "App"; };

/**
 * The tiles of the Apps place. A module with no screen is not an app a person can open, so it is left out. Each tile opens the module's first screen and lists the rest as its sub line.
 * @param {ModuleScreens[]} modules @returns {{ id: string, title: string, sub: string, href: string, icon: string }[]}
 */
export function appTiles(modules) {
  return (modules || []).filter(m => m && m.module && Array.isArray(m.screens) && m.screens.length > 0).map(m => {
    const first = m.screens[0];
    return { id: m.module, title: m.label || titleOf(m.module), sub: m.screens.map(s => s.label).join(", "), href: moduleHref(m.module, first.id), icon: first.icon || "grid" };
  }).sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/** Where "Make an app" goes: an Engineer chat, which drafts the app. */
export const MAKE_AN_APP_HREF = "/u/engineer";
