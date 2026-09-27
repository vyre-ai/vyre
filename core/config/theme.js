// @ts-check
// Vyre's colours as config: `theme.colors` { dark: {...}, light: {...} } in config.json, keyed by
// the custom property names the Deck uses without their dashes. THEME_COLORS below is the palette
// itself (docs/design/TOKENS.md draws its tables from it, and test/theme-defaults.test.js holds
// deck/css/tokens.css and deck/css/deck.css to it); THEME_USE says what each one is for. Those two
// stylesheets paint these defaults; GET /theme.css (core/daemon) turns whatever config overrides into custom
// properties, dark on :root and light on :root[data-theme="paper"]. A value that is not a plain
// CSS colour is dropped, so config can never add a rule, an import or a url().

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COLOUR = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

/** The defaults: dark is the TOKENS palette; light is Paper, by the role names the Deck swaps. */
export const THEME_COLORS = {
  dark: {
    "graphite": "#0E0D0C", "carbon": "#161513", "raised": "#1E1C1A", "rule": "#2B2926", "rule-strong": "#3A3733",
    "ash": "#8C877D", "stone": "#B3AEA4", "bone": "#F1EEE6",
    "signal": "#C6F36B", "signal-hover": "#D4F88A", "signal-ink": "#0E0D0C", "signal-wash": "rgba(198,243,107,0.12)",
    "beacon": "#B8A4FF", "beacon-badge-ink": "#0E0D0C",
    "code-bg": "#121110",
  },
  light: {
    "bg": "#F4F1EA", "panel": "#FBFAF6", "hover": "#EEEAE2", "rule": "#DCD7CC", "rule-strong": "#C9C3B7",
    "text": "#141311", "text-2": "#4A463F", "label": "#6B665D",
    "primary-bg": "#141311", "primary-hover": "#4A463F", "primary-ink": "#F4F1EA",
    "focus": "#46700C", "signal-wash": "rgba(70,112,12,0.10)",
    "beacon-ink": "#5B3FC4", "beacon-dot": "#5B3FC4", "beacon-badge-ink": "#F4F1EA",
    "code-bg": "#F0EDE5",
  },
};

export const THEME_USE = {
  dark: {
    "graphite": "Page ground. Warm graphite black.",
    "carbon": "Panels, windows, app-icon tile. One step up from ground.",
    "raised": "Hover rows, popovers, tab strips. Use rarely.",
    "rule": "Hairline rules and dividers (1px). The default separator.",
    "rule-strong": "Input borders, swatch outlines, vertical rules in lockups.",
    "ash": "Engraved labels, captions, placeholders. 5.4:1 on graphite. Smallest text colour allowed.",
    "stone": "Secondary text. 9:1 on graphite.",
    "bone": "Primary text, the wire in the mark.",
    "signal": "Focus and the one primary action per view. The mark's dot. Never decoration, never a large fill.",
    "signal-hover": "Hover on signal-filled buttons.",
    "signal-ink": "Text on a signal fill.",
    "signal-wash": "Selected row, focus ring fill.",
    "beacon": "Needs you. Held tool calls, approvals, the menu-bar dot. Nothing else.",
    "beacon-badge-ink": "The count on a beacon dot badge.",
    "code-bg": "Behind code and command output.",
  },
  light: {
    "bg": "Ground (paper).",
    "panel": "Panels (paper raised).",
    "hover": "Hover rows.",
    "rule": "Hairlines.",
    "rule-strong": "Input borders.",
    "text": "Primary text and the mark (ink).",
    "text-2": "Secondary text.",
    "label": "Labels. 5.0:1 on paper.",
    "primary-bg": "Primary buttons: ink fill with paper text.",
    "primary-hover": "Hover on a primary button.",
    "primary-ink": "Text on a primary button.",
    "focus": "Signal on paper: focus rings and primary text links.",
    "signal-wash": "Selected row, focus ring fill.",
    "beacon-ink": "Beacon on paper, for text.",
    "beacon-dot": "Beacon on paper, for the dot graphic.",
    "beacon-badge-ink": "The count on a beacon dot badge.",
    "code-bg": "Behind code and command output.",
  },
};

/**
 * Dark swatch names config has always used, and the roles deck.css used to derive from them. The
 * roles now come from the generated deck/css/tokens.css, so an override of a swatch is also written
 * to its roles here (unless config names the role itself): { dark: { graphite } } still repaints
 * the ground.
 */
export const ROLES_OF = {
  "graphite": ["bg"], "carbon": ["panel"], "raised": ["hover"],
  "bone": ["text"], "stone": ["text-2"], "ash": ["label"],
  "signal": ["primary-bg", "focus", "mark-dot"], "signal-hover": ["primary-hover"], "signal-ink": ["primary-ink"],
  "beacon": ["beacon-ink", "beacon-dot"],
};

/** @param {any} set @returns {[string, string][]} the valid entries */
function valid(set) {
  if (!set || typeof set !== "object" || Array.isArray(set)) return [];
  return Object.entries(set).filter(([k, v]) => NAME.test(k) && typeof v === "string" && COLOUR.test(v.trim()))
    .map(([k, v]) => [k, v.trim()]);
}

/** @param {[string, string][]} entries @param {boolean} alias @returns {string[]} "--name: value;" lines */
function lines(entries, alias) {
  const out = entries.map(([k, v]) => `  --${k}: ${v};`);
  if (!alias) return out;
  const named = new Set(entries.map(([k]) => k));
  for (const [k, v] of entries) for (const role of /** @type {Record<string, string[]>} */ (ROLES_OF)[k] || []) {
    if (!named.has(role)) { named.add(role); out.push(`  --${role}: ${v};`); }
  }
  return out;
}

/**
 * The stylesheet for config's theme.colors. Empty sets make an empty stylesheet. The Deck links it
 * after tokens.css and deck.css under the same selectors, so config wins over both.
 * @param {any} colors
 * @returns {string}
 */
export function themeCss(colors) {
  const dark = lines(valid(colors && colors.dark), true), light = lines(valid(colors && (colors.light || colors.paper)), false);
  const out = ["/* Vyre's colours from config (theme.colors); the defaults are in tokens.css and deck.css. */"];
  if (dark.length) out.push(":root {", ...dark, "}");
  if (light.length) out.push(':root[data-theme="paper"] {', ...light, "}");
  return out.join("\n") + "\n";
}
