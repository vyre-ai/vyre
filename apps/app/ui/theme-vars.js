// @ts-check
// @vyre/ui/theme-vars: the custom properties that restyle every component. Pure, so Node tests it. Input is the resolved theme
// (deck/ui/theme.js: defaults, then the space, then the person) and the token source (lib/theme/tokens.json v2 and v3);
// output is a flat { "--name": value } map the ThemeProvider writes on its root view. Nothing here is a design choice: every number is a token.
import { V3 } from "../src/vendor/deck/ui/tokens-v3.js";
import { tokens } from "../src/theme/tokens";

const kebab = (/** @type {string} */ s) => s.replace(/[A-Z0-9]/g, (c) => "-" + c.toLowerCase());

/** The type roles, in the order the components use them. */
export const ROLES = ["caption", "secondary", "body", "headline", "control", "read", "title", "page", "display", "micro"];

/** [size, line height] per role: a phone follows its platform (iOS text styles, Android Material roles); wide screens and the web use the web table. Pure. @param {string} os @param {boolean} phone */
export function typeScale(os, phone) {
  const t = /** @type {any} */ (tokens).v2.type.platform;
  return /** @type {Record<string, [number, number]>} */ (!phone ? t.web : os === "android" ? t.android : t.ios);
}

/**
 * @param {{ scheme: "dark"|"paper", accent: string, accentInk: string, accentWash: string, tint: string, density: string, corners: string, largerText: boolean }} r
 * @param {{ phone: boolean, os?: string }} where
 * @returns {Record<string, string|number>}
 */
export function themeVars(r, { phone, os = "web" }) {
  /** @type {Record<string, string|number>} */
  const out = {};
  const v2 = /** @type {any} */ (tokens).v2;
  for (const [k, v] of Object.entries(v2.color[r.scheme])) out["--" + kebab(k)] = /** @type {string} */ (v);
  out["--accent"] = r.accent; out["--accent-ink"] = r.accentInk; out["--accent-wash"] = r.accentWash; out["--tint"] = r.tint;
  const step = /** @type {any} */ (V3.density.steps)[r.density] ?? V3.density.steps.default;
  for (const n of V3.spaceSteps) out[`--s-${n}`] = Math.round(4 * n * step.space);
  const corner = /** @type {any} */ (V3.corners.steps)[r.corners] ?? 1;
  // The card is 16 on a phone and 14 wider; the hero card 20 and 16; buttons 12 and 10 (ui-system.md section 1).
  const base = /** @type {Record<string, number>} */ ({ ...v2.radius, card: phone ? v2.radius.cardPhone : v2.radius.card, cardHero: phone ? v2.radius.cardHeroPhone : v2.radius.cardHero, button: phone ? v2.radius.buttonTouch : v2.radius.button });
  for (const k of V3.corners.applies) out[`--r-${k}`] = Math.round(base[k] * corner);
  out["--r-full"] = v2.radius.full;
  // A phone keeps its targets: 44 for a control, 36 for a small one (ui-system.md); wider screens follow the density step.
  out["--touch"] = v2.control.touch; out["--control"] = phone ? v2.control.touch : step.control; out["--control-sm"] = phone ? v2.control.touchSm : step.controlSm; out["--row-h"] = phone ? Math.max(step.row, v2.control.rowPhone) : step.row;
  const scale = typeScale(os, phone);
  const bump = r.largerText ? 1.12 : 1;
  for (const k of ROLES) {
    const [fs, lh] = k === "body" && !phone ? step.body : scale[k];
    out[`--fs-${k}`] = Math.round(fs * bump); out[`--lh-${k}`] = Math.round(lh * bump);
  }
  out["--page-max"] = v2.layout.pageMax; out["--read-max"] = v2.layout.readMax;
  // Now and other two-column pages: the side column (340) and the content width (1040) that holds a 640 main, a 32 gap and the side.
  out["--side"] = v2.layout.side; out["--wide-max"] = 1040;
  // Lengths carry their unit: a bare number is not a CSS length on the web.
  for (const k of Object.keys(out)) if (/^--(s-|r-|control|touch|row-h|fs-|lh-|page-max|read-max|side|wide-max)/.test(k)) out[k] = `${out[k]}px`;
  return out;
}
