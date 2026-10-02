// @ts-check
// The More sheet: the places that are not one of the phone's four tabs (team/0.2.2/ux-prototype.html, "More"). It is the
// Places sheet (js/places.js, the one list of places) with the four tabs left out: a head with the person's initial, name and the
// box's address (and the path to it when link.health knows it), a grid of tiles, and the hold that pins one as a page after Agents.
// A tap opens the place pushed and closes the sheet. Styles: css/sheet.css (.plc-*), css/tabbar.css (.sheet-more).

import { TILES, fillPlaces } from "./places.js";

/** The four tabs; every other place in js/places.js is a tile, in that order. */
const TABS = new Set(["/now", "/chat", "/projects", "/agents"]);
/** @type {readonly { href: string, label: string, icon: string }[]} */
export const MORE = Object.freeze(TILES.filter(p => !TABS.has(p.href)));

/**
 * Fill an open sheet (openSheet's build) with More.
 * @param {HTMLElement} body
 * @param {() => void} close
 * @param {{ head: HTMLElement, sheet: HTMLElement }} parts
 * @param {Omit<Parameters<typeof fillPlaces>[3], "tiles">} o
 * @returns {{ tiles: HTMLElement[], stop: () => void }}
 */
export function fillMore(body, close, parts, o) {
  parts.sheet.classList.add("sheet-more");
  return fillPlaces(body, close, parts, { ...o, tiles: MORE });
}
