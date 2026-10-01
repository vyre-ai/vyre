// @ts-check
// An artifact's design is its agent's to make (the user's ruling, 1 Oct): colours, fonts, per-slide
// backgrounds, brand marks. Vyre's Bone look is only the default. Style freedom, not network
// freedom: every value an agent supplies is checked here against a strict shape before it reaches
// a style, so a theme can colour and lay out but never load anything, close a rule, or carry markup.
// Values that fail the check are dropped, never repaired, and the page says nothing about them.

const CUSS = /url|expression|image-set|attr\s*\(|var\s*\(|env\s*\(|@|\\|;|\{|\}|<|>|\/\*|"|'|javascript|behavior|binding/i;

/** A CSS colour or gradient: a hex, a colour function or name, or a gradient of those. @param {unknown} v */
export function colorOf(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 200 || CUSS.test(s)) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^[a-z]{3,24}$/i.test(s)) return s.toLowerCase();
  if (/^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|linear-gradient|radial-gradient|conic-gradient)\([#\w\s.,%()+\-\/]*\)$/i.test(s)) return s;
  return null;
}

/** A font stack from plain family names, each quoted here. @param {unknown} v */
export function fontOf(v) {
  if (typeof v !== "string" || v.length > 160 || !/^[A-Za-z0-9 ,_-]+$/.test(v)) return null;
  const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);
  const fams = v.split(",").map(f => f.trim()).filter(Boolean).slice(0, 6);
  return fams.length ? fams.map(f => (GENERIC.has(f.toLowerCase()) ? f.toLowerCase() : `'${f}'`)).join(", ") : null;
}

/** A length in px, rem, em, % or cqw, or a bare number (px). @param {unknown} v @param {number} [min] @param {number} [max] */
export function lengthOf(v, min = 0, max = 1000) {
  const m = /^(\d{1,4}(?:\.\d{1,3})?)(px|rem|em|%|cqw)?$/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n < min || n > max ? null : `${n}${m[2] || "px"}`;
}

/** An image carried in the artifact as a data URI: nothing else is ever loaded. @param {unknown} v */
export function dataImageOf(v) {
  return typeof v === "string" && v.length <= 4_000_000 && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

// What a theme may name, and the design token each sets (the names a model would guess work too).
const KEYS = /** @type {Record<string,string>} */ ({
  background: "panel", surface: "panel", page: "panel", panel: "panel",
  canvas: "bg", bg: "bg", card: "hover", hover: "hover",
  text: "text", color: "text", muted: "t2", text2: "t2", label: "label", rule: "rule", grid: "rule", border: "rs",
  accent: "s1", series1: "s1", series2: "s2", slide: "slide", ink: "ink", focus: "focus",
  node: "panel", decision: "hover", stroke: "rs", edge: "t2", group: "rule",
  code: "code", docbg: "doc-bg",
});

/** @param {any} t */
function vars(t) {
  /** @type {string[]} */ const out = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) return out;
  for (const [k, v] of Object.entries(t)) {
    const token = KEYS[k.toLowerCase()];
    const c = token ? colorOf(v) : null;
    if (token && c) out.push(`--${token}:${c}`);
  }
  // Body copy and labels follow the text colour unless the theme names its own muted ones.
  const text = colorOf(t.text ?? t.color);
  if (text && !out.some(x => x.startsWith("--t2:"))) out.push(`--t2:${text}`);
  if (text && !out.some(x => x.startsWith("--label:"))) out.push(`--label:${text}`);
  // A theme that names a surface or a text colour gets the rest of the surfaces derived from them, so
  // Vyre's own greys never show through a themed page (explicit keys below still win).
  const derive = [];
  const panel = colorOf(t.background ?? t.surface ?? t.page ?? t.panel), mix = (/** @type {number} */ pct) => `color-mix(in srgb, var(--text) ${pct}%, var(--panel))`;
  if (panel || text) {
    derive.push(`--hover:${mix(8)}`, `--rule:${mix(16)}`, `--rs:${mix(28)}`, `--bo:${mix(22)}`, `--bg:${mix(4)}`);
    if (text) derive.push(`--s1:${text}`, `--s2:${mix(62)}`);
  }
  out.unshift(...derive);
  const f = fontOf(t.font || t.fontFamily);
  if (f) out.push(`--font:${f}`);
  const hf = fontOf(t.headingFont || t.heading);
  if (hf) out.push(`--hfont:${hf}`);
  return out;
}

/**
 * A theme object to a style element. { ...colours } sets both colour modes; { light: {...}, dark: {...} }
 * sets each. Returns "" for nothing usable.
 * @param {any} theme
 */
export function themeCss(theme) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return "";
  const both = vars(theme), light = vars(theme.light), dark = vars(theme.dark);
  const parts = [];
  if (both.length || light.length) parts.push(`:root{${[...both, ...light].join(";")}}`);
  // The dark block follows the media query that holds Vyre's own dark tokens, so it wins in dark.
  if (both.length || dark.length) parts.push(`@media (prefers-color-scheme:dark){:root{${[...both, ...dark].join(";")}}}`);
  return parts.length ? `<style>${parts.join("")}</style>` : "";
}

/**
 * A Markdown document's theme from `@theme {json}` lines at its top: the text without them, and the
 * style element. The page background is the theme's background (or bg), the rest as in themeCss.
 * @param {string} md
 * @returns {{ md: string, css: string }}
 */
export function docTheme(md) {
  /** @type {any} */ let theme = null;
  const keep = String(md).split("\n").filter(l => { const m = /^@theme\s+(\{.*\})\s*$/.exec(l.trim()); if (!m) return true; if (!theme) try { theme = JSON.parse(m[1]); } catch {} return false; });
  const fix = (/** @type {any} */ o) => { if (!o || typeof o !== "object" || Array.isArray(o)) return o; const x = { ...o }; if (x.background || x.bg) { x.docbg = x.background || x.bg; delete x.background; delete x.bg; } return x; };
  const f = fix(theme);
  if (f) { f.light = fix(f.light); f.dark = fix(f.dark); }
  return { md: keep.join("\n"), css: themeCss(f) };
}
