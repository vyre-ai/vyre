// @ts-check
// The rail (docs/design/system/components/rail.md): the place switcher from 720 px up. A 64 px
// column: the home mark, then seven places Now, Chat, Projects, Agents, Memory, Vault, Drive, and
// at the bottom Search, Settings and the person's avatar. Each place is an icon 20 over its label
// at 12/16; the current one is filled --hover with its label at 600. The needs-you badge on Now is
// the only colour in it (js/status-mark.js). Cmd+1 to Cmd+9 (Ctrl+1 to Ctrl+9 off a Mac) open the
// places in rail order. Styles: css/deck.css (.rail). The phone has no rail (js/app.js).
//
// Planner is /planner. Devices is a Settings section for now, /settings#devices (views/settings.js
// scrolls to it, and again when a kept Settings page comes back). The avatar opens Settings until
// the account menu is drawn.

import { macKeys } from "./mac-keys.js";
import { ALL } from "./place-list.js";
import { h, put, link } from "./dom.js";
import { icon, mark } from "./icons.js";
import { badge } from "./status-mark.js";

/** The places on the rail, in rail order: js/place-list.js's, the one list the phone's sheets read too. */
export const PLACES = Object.freeze(ALL.filter(p => p.rail));

/**
 * The place a route is in: the view's place, except that Settings scrolled to its devices
 * section is Devices.
 * @param {string} view @param {string} [hash] location.hash
 * @returns {string | null} the place's label
 */
export function placeOf(view, _hash = "") {
  return PLACES.find(p => p.views.includes(view))?.label || null;
}

/** True when a key press lands in something that takes text: the rail keys stay out of it. */
export function typing(/** @type {any} */ t) {
  for (let n = t; n && n.tagName; n = n.parentNode) {
    if (n.isContentEditable) return true;
    const tag = String(n.tagName).toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    const ce = typeof n.getAttribute === "function" ? n.getAttribute("contenteditable") : null;
    if (ce !== null && ce !== "false") return true;
  }
  return false;
}

// A Mac (or an iPad with a keyboard) uses Cmd; everything else Ctrl (js/mac-keys.js, kept out of
// this file so js/platform.js reads it without loading the rail's icons).
export { macKeys };

/**
 * Where Cmd+digit (Ctrl+digit off a Mac) goes: the place's href, or null when the press is not a
 * rail key (another modifier, not a digit 1 to 9, already handled, or typed into a field).
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, defaultPrevented?: boolean, target?: any }} e
 * @param {boolean} mac
 */
export function placeForKey(e, mac) {
  if (e.defaultPrevented || e.altKey || e.shiftKey) return null;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null;
  if (typing(e.target)) return null;
  return PLACES.find(p => p.key === e.key)?.href || null;
}

/** Now's accessible name: "Now", or "Now, 5 need you" while something waits. */
export function nowLabel(/** @type {number} */ n) {
  if (!n) return "Now";
  return n > 99 ? "Now, more than 99 need you" : `Now, ${n} need${n === 1 ? "s" : ""} you`;
}

/**
 * The rail's elements. setNeeds(n) moves the badge and the mark's dot; setCurrent(view, hash)
 * marks the place; setOwner(name, letter, face) puts the person's avatar (else initial) and name on it.
 */
export function rail({ onSearch = () => {} } = {}) {
  const count = /** @type {HTMLElement} */ (badge(0));
  count.setAttribute("aria-hidden", "true");
  const place = (/** @type {typeof PLACES[number]} */ p) => link(p.href, { class: "rail-place", "data-place": p.label, "aria-keyshortcuts": `Meta+${p.key} Control+${p.key}` },
    icon(/** @type {any} */ (p.icon), 20), h("span", { class: "rail-label" }, p.label), p.label === "Now" ? count : null);
  const links = PLACES.map(place);
  const byLabel = new Map(links.map(a => [a.getAttribute("data-place"), a]));
  const initial = h("span", { class: "rail-initial", "aria-hidden": "true" }, "V");
  const ownerName = h("span", { class: "rail-name", "aria-hidden": "true" }, "");
  const avatar = link("/settings", { class: "rail-avatar", "aria-label": "Account", title: "Account" }, initial, ownerName);
  const home = link("/now", { class: "rail-home", "aria-label": "Vyre home" }, mark(22), h("span", { class: "rail-word", "aria-hidden": "true" }, "Vyre"));
  const search = h("button", { type: "button", class: "rail-place rail-search", "data-place": "Search", "aria-label": "Search", "aria-keyshortcuts": "Meta+K Control+K", onclick: () => onSearch() },
    icon(/** @type {any} */ ("search"), 20), h("span", { class: "rail-label" }, "Search"));
  const el = h("nav", { class: "rail", "aria-label": "Vyre" },
    home,
    h("div", { class: "rail-set" }, links.filter((_, i) => !PLACES[i].end)),
    h("div", { class: "rail-set rail-end" }, search, links.filter((_, i) => PLACES[i].end), avatar));

  function setNeeds(/** @type {number} */ n) {
    badge(n, count);
    count.setAttribute("aria-hidden", "true");
    const now = /** @type {HTMLElement} */ (byLabel.get("Now"));
    if (n) now.setAttribute("aria-label", nowLabel(n)); else now.removeAttribute("aria-label");
    if (n) el.setAttribute("data-needs", ""); else el.removeAttribute("data-needs");
  }
  function setCurrent(/** @type {string} */ view, /** @type {string} */ hash = "") {
    const here = placeOf(view, hash);
    for (const [label, a] of byLabel) {
      if (label === here) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
  }
  /** `face`: the person's avatar (js/avatars.js), which takes the initial's place once system.info has answered. */
  function setOwner(/** @type {string | null | undefined} */ name, /** @type {string} */ letter, /** @type {Element | null} */ face = null) {
    initial.replaceChildren(face || letter || "V");
    avatar.setAttribute("title", name || "Account");
    put(ownerName, name || "");
  }
  return { el, links, search, avatar, home, count, setNeeds, setCurrent, setOwner };
}
