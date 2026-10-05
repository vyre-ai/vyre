// @ts-check
// store-core/theme (moved from the old Deck's ui/theme): the one place the Deck's look is configured (ui-primitives.md section 2). Resolution is fixed: the defaults, then the space, then the
// person, and the person wins only for what is theirs (theme, density, font, motion, text size). The result is written as custom properties and
// attributes on the root element, so every component updates with no code of its own. Contrast is computed, never chosen: a custom accent that does
// not read on the page is replaced by the nearest one that does, and its ink is picked by luminance. Status colours never change.
//
//   resolveTheme({ space, person, system })  pure: the settings that apply and the colours they give
//   applyTheme(root, resolved)               writes them onto an element (the root)
//
// A space setting is { accent, hex, tint, thex, density, font, corners }; a person setting is { theme, density, font, reducedMotion, largerText }.

import { V3 } from "./tokens-v3.js";
import { inkOn, isHex, nearestPassing, rgba } from "../../../../lib/theme/contrast.js";

/** @typedef {{ accent?: string, hex?: string, tint?: string, thex?: string, density?: string, font?: string, corners?: string }} SpaceTheme */
/** @typedef {{ theme?: "dark"|"paper"|"system", density?: string|null, font?: string|null, reducedMotion?: boolean, largerText?: boolean }} PersonTheme */
/** @typedef {{ scheme: "dark"|"paper", accent: string, accentInk: string, accentWash: string, tint: string, density: string, font: string, corners: string,
 *   reducedMotion: boolean, largerText: boolean, note: string|null, own: string[] }} Resolved */

export const ACCENTS = V3.accents;
export const DENSITIES = Object.keys(V3.density.steps);
export const FONTS = Object.keys(V3.font.stacks);
export const CORNERS = Object.keys(V3.corners.steps);

/**
 * @param {{ space?: SpaceTheme, person?: PersonTheme, system?: "dark"|"paper" }} [input] system: the scheme the device prefers, for a person's "system"
 * @returns {Resolved}
 */
export function resolveTheme({ space = {}, person = {}, system = "dark" } = {}) {
  const scheme = person.theme === "dark" || person.theme === "paper" ? person.theme : system;
  const own = /** @type {string[]} */ ([]);
  const pick = (/** @type {string|null|undefined} */ mine, /** @type {string|undefined} */ theirs, /** @type {string[]} */ allowed, /** @type {string} */ dflt, /** @type {string} */ name) => {
    if (mine && allowed.includes(mine)) { own.push(name); return mine; }
    return theirs && allowed.includes(theirs) ? theirs : dflt;
  };
  const density = pick(person.density, space.density, DENSITIES, V3.density.default, "density");
  const font = pick(person.font, space.font, FONTS, V3.font.default, "font");
  const corners = space.corners && CORNERS.includes(space.corners) ? space.corners : V3.corners.default;
  let note = /** @type {string|null} */ (null);
  const accentOf = (/** @type {string|undefined} */ key, /** @type {string|undefined} */ hex) => {
    if (key === "custom" && isHex(hex)) {
      const fixed = nearestPassing(/** @type {string} */ (hex), scheme, V3.contrast);
      if (fixed.changed) note = `${hex} is too low in contrast here. Using ${fixed.hex} instead.`;
      return fixed.hex;
    }
    const a = /** @type {any} */ (ACCENTS)[key || "violet"] || ACCENTS.violet;
    return a[scheme];
  };
  const accent = accentOf(space.accent, space.hex);
  const tint = !space.tint || space.tint === "accent" ? accent : accentOf(space.tint, space.thex);
  return {
    scheme, accent, accentInk: inkOn(accent), accentWash: rgba(accent, scheme === "paper" ? 0.1 : 0.12), tint,
    density, font, corners, reducedMotion: !!person.reducedMotion, largerText: !!person.largerText, note, own,
  };
}

/**
 * Write a resolved theme onto an element. Density, font and corners are attributes (css/tokens-v3.css scales from them); the accent is set directly.
 * @param {HTMLElement} root @param {Resolved} r
 */
export function applyTheme(root, r) {
  if (r.scheme === "paper") root.dataset.theme = "paper"; else delete root.dataset.theme;
  root.dataset.density = r.density;
  root.dataset.font = r.font;
  root.dataset.corners = r.corners;
  root.toggleAttribute("data-reduced-motion", r.reducedMotion);
  root.toggleAttribute("data-larger-text", r.largerText);
  const st = root.style;
  st.setProperty("--accent", r.accent);
  st.setProperty("--accent-ink", r.accentInk);
  st.setProperty("--accent-wash", r.accentWash);
  st.setProperty("--tint", r.tint);
}
