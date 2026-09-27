// @ts-check
// Vyre's colours as config: `theme.colors` { dark: {...}, light: {...} } in config.json, keyed by
// the custom property names the Deck uses without their dashes. THEME_COLORS below is the palette
// itself (docs/design/TOKENS.md draws its tables from it, and test/theme-defaults.test.js holds
// deck/css/deck.css to it); THEME_USE says what each one is for. The Deck's own stylesheet keeps
// these defaults; GET /theme.css (core/daemon) turns whatever config overrides into custom
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
    "recall": "#EBC76B", "recall-wash": "rgba(235,199,107,0.10)",
    "beacon": "#B8A4FF", "beacon-wash": "rgba(184,164,255,0.12)", "beacon-rule": "rgba(184,164,255,0.28)", "beacon-badge-ink": "#0E0D0C",
    "code-bg": "rgba(14,13,12,0.45)",
  },
  light: {
    "bg": "#F4F1EA", "panel": "#FBFAF6", "hover": "#FBFAF6", "rule": "#DCD7CC", "rule-strong": "#C9C3B7",
    "text": "#141311", "text-2": "#4A463F", "label": "#6B665D",
    "primary-bg": "#141311", "primary-hover": "#4A463F", "primary-ink": "#F4F1EA",
    "focus": "#46700C", "signal-wash": "rgba(70,112,12,0.10)",
    "recall-ink": "#7E5B0C", "recall-wash": "rgba(126,91,12,0.08)", "recall": "#7E5B0C",
    "beacon-ink": "#5B3FC4", "beacon-dot": "#5B3FC4", "beacon-wash": "rgba(91,63,196,0.08)", "beacon-rule": "rgba(91,63,196,0.28)", "beacon-badge-ink": "#F4F1EA",
    "code-bg": "rgba(20,19,17,0.06)",
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
    "recall": "Came from your memory; no model was used. Only where memory surfaces: recalled facts, enrichment lines, memory-graph nodes.",
    "recall-wash": "Background behind a recalled block.",
    "beacon": "Needs you. Held tool calls, approvals, the menu-bar dot. Nothing else.",
    "beacon-wash": "Background behind a held item.",
    "beacon-rule": "The border of a held item.",
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
    "recall-ink": "Recall on paper: text that came from memory.",
    "recall-wash": "Background behind a recalled block.",
    "recall": "Recall marks on paper.",
    "beacon-ink": "Beacon on paper, for text.",
    "beacon-dot": "Beacon on paper, for the dot graphic.",
    "beacon-wash": "Background behind a held item.",
    "beacon-rule": "The border of a held item.",
    "beacon-badge-ink": "The count on a beacon dot badge.",
    "code-bg": "Behind code and command output.",
  },
};

/** @param {any} set @returns {string[]} "--name: value;" lines for the valid entries */
function lines(set) {
  if (!set || typeof set !== "object" || Array.isArray(set)) return [];
  return Object.entries(set).filter(([k, v]) => NAME.test(k) && typeof v === "string" && COLOUR.test(v.trim()))
    .map(([k, v]) => `  --${k}: ${v.trim()};`);
}

/**
 * The stylesheet for config's theme.colors. Empty sets make an empty stylesheet.
 * @param {any} colors
 * @returns {string}
 */
export function themeCss(colors) {
  const dark = lines(colors && colors.dark), light = lines(colors && (colors.light || colors.paper));
  const out = ["/* Vyre's colours from config (theme.colors); the defaults are in deck.css. */"];
  if (dark.length) out.push(":root {", ...dark, "}");
  if (light.length) out.push(':root[data-theme="paper"] {', ...light, "}");
  return out.join("\n") + "\n";
}
