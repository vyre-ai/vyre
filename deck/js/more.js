// @ts-check
// The More sheet: the places that are not one of the phone's four tabs (team/0.2.2/ux-prototype.html,
// "More"). A head with the person's initial, name and the box's address (and the path to it when
// link.health knows it), then a grid of tiles, then nothing else: no hints, no holds. A tap opens the
// place pushed and closes the sheet. Styles: css/sheet.css (.plc-*, shared with the sheet it replaced).

import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { PLACES } from "./rail.js";
import { closeGlyph } from "./sheet.js";

/** The four tabs; every other rail place is a tile, in rail order. */
const TABS = new Set(["/now", "/chat", "/projects", "/agents"]);
/** @type {readonly { href: string, label: string, icon: string }[]} */
export const MORE = Object.freeze(PLACES.filter(p => !TABS.has(p.href)).map(p => ({ href: p.href, label: p.label, icon: p.icon })));

/**
 * Fill an open sheet (openSheet's build) with More.
 * @param {HTMLElement} body
 * @param {() => void} close
 * @param {{ head: HTMLElement, sheet: HTMLElement }} parts
 * @param {{ name?: string | null, letter?: string, host?: string, open: (tile: typeof MORE[number]) => void,
 *   health?: (fn: (x: any | null) => void) => () => void, line?: (x: any) => string }} o
 * @returns {{ tiles: HTMLElement[], stop: () => void }}
 */
export function fillMore(body, close, parts, o) {
  parts.sheet.classList.add("sheet-places", "sheet-more");
  const where = h("span", { class: "plc-where" }, o.host || "");
  put(parts.head, h("div", { class: "plc-who" },
    h("span", { class: "plc-avatar", "aria-hidden": "true" }, o.letter || "V"),
    h("div", { class: "plc-id" }, h("span", { class: "plc-name" }, o.name || "Account"), where),
    h("button", { type: "button", class: "sheet-close", "aria-label": "Close", onclick: close }, closeGlyph(16))));
  // The path to the box, only when link.health knows it (the latency is the one it measured).
  const stop = o.health ? o.health(x => {
    const known = x && (x.path === "direct" || x.path === "relay" || x.path === "peer-relay");
    put(where, o.host || "", known && o.line ? ` · ${o.line(x)}` : "");
  }) : () => {};
  const tiles = MORE.map(t => {
    const a = h("a", { href: t.href, class: "plc-tile", "data-place": t.label }, icon(/** @type {any} */ (t.icon), 22), h("span", { class: "plc-label" }, t.label));
    a.addEventListener("click", (/** @type {MouseEvent} */ e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      close();
      o.open(t);
    });
    return a;
  });
  put(body, h("nav", { class: "plc-grid", "aria-label": "More" }, tiles));
  return { tiles, stop };
}
