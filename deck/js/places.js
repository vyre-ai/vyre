// @ts-check
// The Places sheet (docs/design/system/components/phone-shell.md, anatomy 5): what the phone's
// avatar opens. A head row with the person's avatar, name and the box's address, a 3 by 2 grid
// of places (Projects, Planner, Memory, Vault, Devices, Settings: the rail's places that are not
// one of the three pages), and a hint. A tap opens the place pushed and closes the sheet; a hold
// of 600 ms (--motion-hold), or the context menu key or Shift+F10 on a focused tile, keeps the
// place as a fourth page after Agents, or lets it go. One kept place at most: a new one replaces
// the old. Kept per device in localStorage "vyre.pin". The sheet is js/sheet.js's; js/app.js
// opens it and moves the pager. Styles: css/sheet.css (.plc-*).

import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { closeGlyph } from "./sheet.js";
import { ALL } from "./place-list.js";

/** The phone's tiles, in order: every place in js/place-list.js that is not one of the phone's four tabs (More takes the same list). */
/** @type {readonly { href: string, label: string, icon: string }[]} */
export const TILES = Object.freeze(ALL.filter(p => !["/now", "/chat", "/agents"].includes(p.href)).map(p => ({ href: p.href, label: p.label, icon: p.icon })));

export const PIN_KEY = "vyre.pin";
export const HOLD_HINT = "Long-press a tile to pin it as a page.";
const HOLD = "Long-press to pin as a page";
const KEPT = "Pinned as a page";

/** @param {any} [store] */
const storage = store => { try { return store ?? globalThis.localStorage ?? null; } catch { return null; } };

/**
 * The place kept as a fourth page on this device, or null. Anything stored that is not a tile
 * reads as none.
 * @param {any} [store]
 */
export function readPin(store) {
  try {
    const href = storage(store)?.getItem(PIN_KEY);
    return TILES.find(t => t.href === href) || null;
  } catch { return null; }
}

/**
 * Keep `href` as the fourth page (replacing any other), or none with null.
 * @param {string | null} href @param {any} [store]
 * @returns {typeof TILES[number] | null} what is kept now
 */
export function writePin(href, store) {
  const tile = href ? TILES.find(t => t.href === href) || null : null;
  try {
    const s = storage(store);
    if (tile) s?.setItem(PIN_KEY, tile.href); else s?.removeItem(PIN_KEY);
  } catch {}
  return tile;
}

/** Keep the place, or let it go when it is the one kept. @param {string} href @param {any} [store] */
export function togglePin(href, store) {
  return writePin(readPin(store)?.href === href ? null : href, store);
}

/** The hold, from --motion-hold on :root (600 ms when it is not set). */
function holdMs() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--motion-hold").trim();
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return /ms$/.test(v) ? n : /s$/.test(v) ? n * 1000 : n;
  } catch {}
  return 600;
}

/**
 * Fill an open sheet (openSheet's build) with the Places.
 * @param {HTMLElement} body
 * @param {() => void} close
 * @param {{ head: HTMLElement, sheet: HTMLElement }} parts
 * @param {{ name?: string | null, letter?: string, host?: string, open: (tile: typeof TILES[number]) => void,
 *   pinned?: (tile: typeof TILES[number] | null) => void, store?: any, hold?: number,
 *   health?: (fn: (x: any | null) => void) => () => void, line?: (x: any) => string, tiles?: readonly typeof TILES[number][] }} o  tiles: the places to show (default all of TILES; the phone's More sheet leaves out its tabs)
 * @returns {{ tiles: HTMLElement[], stop: () => void }}
 */
export function fillPlaces(body, close, parts, o) {
  parts.sheet.classList.add("sheet-places");
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

  const hold = o.hold ?? holdMs();
  // A kept place leads the grid: it is a page now, and this is where to find it again.
  const kept0 = readPin(o.store);
  const list = [...(o.tiles || TILES)].sort((a, b) => (kept0 && b.href === kept0.href ? 1 : 0) - (kept0 && a.href === kept0.href ? 1 : 0));
  const tiles = list.map(t => {
    // heldAt: when a hold last toggled; swallow: the click that ends that press opens nothing.
    let timer = 0, heldAt = 0, swallow = false, x0 = 0, y0 = 0;
    const a = h("a", { href: t.href, class: "plc-tile", "data-place": t.label, "aria-keyshortcuts": "Shift+F10 ContextMenu" },
      icon(/** @type {any} */ (t.icon), 20), h("span", { class: "plc-label" }, t.label));
    const toggle = () => {
      const kept = togglePin(t.href, o.store);
      mark(kept);
      o.pinned?.(kept);
    };
    const cancel = () => { clearTimeout(timer); timer = 0; a.classList.remove("holding"); };
    a.addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => {
      if (e.button !== 0) return;
      x0 = e.clientX; y0 = e.clientY;
      cancel();
      swallow = false;
      a.classList.add("holding");
      timer = window.setTimeout(() => { timer = 0; heldAt = Date.now(); swallow = true; a.classList.remove("holding"); toggle(); }, hold);
    });
    a.addEventListener("pointermove", (/** @type {PointerEvent} */ e) => {
      if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) a.addEventListener(type, cancel);
    // The keyboard's way to hold: the context menu key or Shift+F10 on a focused tile.
    a.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); toggle(); }
    });
    // Right-click, and a long-press where the browser names it one: the same toggle, never twice
    // for one press, and never the browser's own menu over the tile.
    a.addEventListener("contextmenu", (/** @type {MouseEvent} */ e) => {
      e.preventDefault();
      if (Date.now() - heldAt < 1000) return;
      cancel();
      heldAt = Date.now();
      swallow = true;
      toggle();
    });
    a.addEventListener("click", (/** @type {MouseEvent} */ e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      // The click that ends a hold does not also open the place.
      if (swallow) { swallow = false; return; }
      close();
      o.open(t);
    });
    return a;
  });
  /** @param {typeof TILES[number] | null} kept */
  function mark(kept) {
    for (const a of tiles) {
      const on = kept?.label === a.getAttribute("data-place");
      a.setAttribute("aria-description", on ? KEPT : HOLD);
      if (on) a.setAttribute("data-kept", ""); else a.removeAttribute("data-kept");
    }
  }
  mark(readPin(o.store));
  put(body, h("nav", { class: "plc-grid", "aria-label": "Places" }, tiles), h("p", { class: "plc-hint" }, HOLD_HINT));
  return { tiles, stop };
}
