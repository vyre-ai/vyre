// @ts-check
// lib/theme/contrast: the colour maths a custom accent needs, as pure functions with no imports, so the Deck (a browser) and Node load the one file.
// WCAG relative luminance and contrast, a mix, the nearest passing colour, and the ink (black or white) that reads on a fill.

/** @param {string} hex "#RRGGBB" @returns {number} */
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (/** @type {number} */ c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

/** WCAG contrast of two opaque hex colours. @param {string} a @param {string} b */
export function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** @param {string} a @param {string} b @param {number} t 0 gives a, 1 gives b */
export function mix(a, b, t) {
  const n = parseInt(a.slice(1), 16), m = parseInt(b.slice(1), 16);
  const c = (/** @type {number} */ s) => Math.round(((n >> s) & 255) * (1 - t) + ((m >> s) & 255) * t);
  return "#" + [16, 8, 0].map(s => c(s).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** "rgba(r,g,b,a)" from a hex. @param {string} hex @param {number} a */
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Whether a string is a six-digit hex colour. @param {unknown} v */
export const isHex = v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/**
 * The text colour that reads on an accent fill: near-black on a light fill, white on a dark one.
 * @param {string} fill
 */
export const inkOn = fill => (luminance(fill) > 0.3 ? "#0E0D0C" : "#FFFFFF");

/**
 * A custom accent is refused unless it reads on the page ground (text, 4.5) and its ink reads on it; the nearest passing colour is
 * the same hue pushed toward black on paper or white on dark, 8 percent at a time. Returns the colour to use and whether it changed.
 * @param {string} hex @param {"dark"|"paper"} scheme @param {{ text?: number, grounds?: { dark: string, paper: string } }} [rules]
 * @returns {{ hex: string, changed: boolean }}
 */
export function nearestPassing(hex, scheme, rules = {}) {
  const ground = (rules.grounds || { dark: "#141311", paper: "#F4F1EA" })[scheme];
  const need = rules.text || 4.5;
  const toward = scheme === "paper" ? "#000000" : "#FFFFFF";
  let c = hex.toUpperCase(), i = 0;
  while (ratio(c, ground) < need && i < 40) { c = mix(c, toward, 0.08); i++; }
  return { hex: c, changed: c.toLowerCase() !== hex.toLowerCase() };
}
