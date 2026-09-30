// @ts-check
// Vyre's colours in one place, as roles, for the dark theme and paper. docs/design/TOKENS.md
// names them; deck/css/deck.css declares them (palette.test.js holds the two together). Every
// text-on-colour pair the surfaces draw is listed in PAIRS and must pass WCAG AA: 4.5:1 for body
// text, 3:1 for large text and UI marks (dots, rings, borders that carry meaning).

/**
 * "Needs you", the only hue in the palette. It marks a dot and a label, never a card or a wash.
 * Violet is the pick; teal is the one alternative (honey was dropped by the user, 27 Sep 2026).
 * Coral was retired on 27 Sep 2026; it may not come back (test/hygiene.test.js).
 */
export const ATTENTION = {
  violet: { dark: "#B8A4FF", light: "#5B3FC4" },
  teal: { dark: "#5FD4C4", light: "#0B6E66" },
};

/**
 * The reduced set (deck-design second pass): eight neutrals per theme, no accent hue: bone (cream on dark, ink on paper)
 * carries primary actions, focus and running, plus the attention colour. No gold, no red, no other hue.
 * Memory, success and info are neutrals plus an icon. A removed diff line is a neutral wash.
 */
export const PALETTE = {
  dark: {
    bg: "#0E0D0C", panel: "#161513", hover: "#1E1C1A", rule: "#2B2926", "rule-strong": "#3A3733",
    text: "#F1EEE6", "text-2": "#B3AEA4", label: "#8C877D",
    "primary-bg": "#F1EEE6", "primary-hover": "#FFFFFF", "primary-ink": "#0E0D0C",
    focus: "#F1EEE6", "signal-wash": "rgba(241,238,230,0.12)", "del-wash": "rgba(140,135,125,0.14)",
    "beacon-ink": ATTENTION.violet.dark, "beacon-dot": ATTENTION.violet.dark,
  },
  light: {
    bg: "#F4F1EA", panel: "#FBFAF6", hover: "#EEEAE2", rule: "#DCD7CC", "rule-strong": "#C9C3B7",
    text: "#141311", "text-2": "#4A463F", label: "#6B665D",
    "primary-bg": "#141311", "primary-hover": "#4A463F", "primary-ink": "#F4F1EA",
    focus: "#141311", "signal-wash": "rgba(20,19,17,0.10)", "del-wash": "rgba(107,102,93,0.10)",
    "beacon-ink": ATTENTION.violet.light, "beacon-dot": ATTENTION.violet.light,
  },
};

/**
 * [foreground, background, minimum ratio, what it is]. A background may be a wash, which is
 * composited over `bg` before measuring. Both themes are checked for every pair.
 * @type {[string, string, number, string][]}
 */
export const PAIRS = [
  ["text", "bg", 4.5, "body text"],
  ["text", "panel", 4.5, "text on a card"],
  ["text", "hover", 4.5, "text on a hovered row"],
  ["text-2", "bg", 4.5, "secondary text"],
  ["text-2", "panel", 4.5, "secondary text on a card"],
  ["label", "bg", 4.5, "labels and captions"],
  ["label", "panel", 4.5, "labels on a card"],
  ["primary-ink", "primary-bg", 4.5, "primary button label"],
  ["primary-ink", "primary-hover", 4.5, "primary button label, hovered"],
  ["focus", "bg", 3, "focus ring and running dot"],
  ["focus", "panel", 3, "focus ring on a card"],
  ["text", "signal-wash", 4.5, "selected row, added diff line"],
  ["text-2", "signal-wash", 4.5, "meta text on a selected row (label steps up to text-2 on a wash)"],
  ["text-2", "del-wash", 4.5, "removed diff line"],
  ["beacon-ink", "bg", 4.5, "needs-you label"],
  ["beacon-ink", "panel", 4.5, "needs-you label on a card"],
  ["beacon-ink", "hover", 4.5, "needs-you label on a hovered row"],
  ["beacon-dot", "bg", 3, "needs-you dot"],
  ["primary-ink", "beacon-dot", 4.5, "count on a needs-you badge"],
];

/** The palette with another attention colour swapped in. @param {keyof typeof ATTENTION} name */
export function withAttention(name) {
  const a = ATTENTION[name];
  return {
    dark: { ...PALETTE.dark, "beacon-ink": a.dark, "beacon-dot": a.dark },
    light: { ...PALETTE.light, "beacon-ink": a.light, "beacon-dot": a.light },
  };
}

/** @param {string} c @returns {[number, number, number, number]} r, g, b (0-255) and alpha */
export function parse(c) {
  const s = c.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`not a colour: ${c}`);
}

/** @param {number[]} rgb */
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A colour with alpha, laid over an opaque ground. @param {string} c @param {string} ground */
function flatten(c, ground) {
  const [r, g, b, a] = parse(c), [R, G, B] = parse(ground);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}

/** WCAG contrast ratio of fg over bg, both laid over `ground` first. */
export function contrast(fg, bg, ground) {
  const back = flatten(bg, ground);
  const front = flatten(fg, `rgb(${back.map(Math.round).join(",")})`);
  const [l1, l2] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Every pair that falls short, in both themes. @returns {string[]} */
export function failures(palette = PALETTE) {
  const out = [];
  for (const [theme, set] of Object.entries(palette)) for (const [fg, bg, min, what] of PAIRS) {
    const r = contrast(set[fg], set[bg], set.bg);
    if (r < min) out.push(`${theme}: ${fg} on ${bg} (${what}) is ${r.toFixed(2)}:1, needs ${min}:1`);
  }
  return out;
}
