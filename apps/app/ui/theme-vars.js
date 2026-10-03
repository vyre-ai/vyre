// @ts-check
// @vyre/ui/theme-vars: the custom properties that restyle every component. Pure, so Node tests it. Input is the resolved theme
// (deck/ui/theme.js: defaults, then the space, then the person) and the token source (lib/theme/tokens.json v2 and v3);
// output is a flat { "--name": value } map the ThemeProvider writes on its root view. Nothing here is a design choice: every number is a token.
import { V3 } from "../../../deck/ui/tokens-v3.js";
import { tokens } from "../src/theme/tokens";

const kebab = (/** @type {string} */ s) => s.replace(/[A-Z0-9]/g, (c) => "-" + c.toLowerCase());

/**
 * @param {{ scheme: "dark"|"paper", accent: string, accentInk: string, accentWash: string, tint: string, density: string, corners: string, largerText: boolean }} r
 * @param {{ phone: boolean }} where
 * @returns {Record<string, string|number>}
 */
export function themeVars(r, { phone }) {
  /** @type {Record<string, string|number>} */
  const out = {};
  const v2 = /** @type {any} */ (tokens).v2;
  for (const [k, v] of Object.entries(v2.color[r.scheme])) out["--" + kebab(k)] = /** @type {string} */ (v);
  out["--accent"] = r.accent; out["--accent-ink"] = r.accentInk; out["--accent-wash"] = r.accentWash; out["--tint"] = r.tint;
  const step = /** @type {any} */ (V3.density.steps)[r.density] ?? V3.density.steps.default;
  for (const n of V3.spaceSteps) out[`--s-${n}`] = Math.round(4 * n * step.space);
  const corner = /** @type {any} */ (V3.corners.steps)[r.corners] ?? 1;
  for (const k of V3.corners.applies) out[`--r-${k}`] = Math.round(v2.radius[k] * corner);
  out["--r-full"] = v2.radius.full;
  out["--touch"] = v2.control.touch; out["--control"] = step.control; out["--control-sm"] = step.controlSm; out["--row-h"] = step.row;
  const scale = phone ? v2.type.phone : v2.type.desktop;
  const bump = r.largerText ? 1.12 : 1;
  for (const k of ["caption", "body", "read", "title", "page", "display"]) {
    const [fs, lh] = k === "body" && !phone ? step.body : scale[k];
    out[`--fs-${k}`] = Math.round(fs * bump); out[`--lh-${k}`] = Math.round(lh * bump);
  }
  out["--page-max"] = v2.layout.pageMax; out["--read-max"] = v2.layout.readMax;
  // Lengths carry their unit: a bare number is not a CSS length on the web.
  for (const k of Object.keys(out)) if (/^--(s-|r-|control|touch|row-h|fs-|lh-|page-max|read-max)/.test(k)) out[k] = `${out[k]}px`;
  return out;
}
