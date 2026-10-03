// @ts-check
// lib/theme: Vyre's design tokens and the rules a theme must keep, as a pure library (ADR 0033,
// section 3). tokens.json beside this file is the one token source for every surface. vyred runs
// this code (the appearance module checks every change to appearance.tokens with it), and so do
// the build scripts (scripts/gen-tokens renders tokens.json for Swift, TypeScript and CSS through
// scripts/lib/tokens.js, which re-exports what is here).
//
// No feature state: nothing here reads config, the store or another module. It imports only
// Node's own modules.
//
// An override is a partial tokens.json, deep-merged over the shipped tokens. Objects merge by key;
// arrays and plain values replace. The merged result must keep the rules every surface relies on,
// and one failure refuses the whole override.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** The token source, repo-relative (scripts and tests read it from a checkout). */
export const SOURCE = "lib/theme/tokens.json";
/** The token source on disk, wherever Vyre is installed. */
export const TOKENS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "tokens.json");

/** @type {any} */
let shipped = null;
/** The shipped tokens, a fresh copy each call so a caller can never change them for another. */
export function tokens() {
  if (!shipped) shipped = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  return structuredClone(shipped);
}

/** "#0E0D0C" or "rgba(1,2,3,0.5)" as [r, g, b, a] (0 to 255, alpha 0 to 1). @param {string} value */
export function rgba(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!fn) throw new Error(`not a colour: ${value}`);
  const p = fn[1].split(",").map(s => Number(s.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** A short hash of a token set: the same tokens always give the same version. @param {any} t */
export function version(t) {
  return crypto.createHash("sha256").update(JSON.stringify(t)).digest("hex").slice(0, 12);
}

// ---- CSS custom properties ----

const kebab = (/** @type {string} */ k) => k.replace(/[A-Z0-9]/g, (c, i) => (i ? "-" : "") + c.toLowerCase());

/**
 * The Deck's roles as custom properties, under the selectors deck.css uses (:root is dark, and
 * :root[data-theme="paper"] swaps the roles). Names are the Deck's: --text-2, --rule-strong,
 * --beacon-ink and --beacon-dot for the attention colour, --beacon-badge-ink for a badge's count.
 * @param {any} t the tokens @param {string} [head] the comment on the first line
 */
export function css(t, head = "Vyre's design tokens (lib/theme). Do not edit; change the tokens.") {
  const roles = (/** @type {"dark"|"paper"} */ theme) => {
    const c = t.color[theme];
    const out = Object.entries(c).filter(([k]) => k !== "beacon").map(([k, v]) => [kebab(k), v]);
    out.push(["beacon-ink", c.beacon], ["beacon-dot", c.beacon], ["beacon-badge-ink", c.primaryInk]);
    out.push(["float", t.shadow[theme]], ["popover", t.popover[theme]]);
    return out.map(([k, v]) => `  --${k}: ${v};`).join("\n");
  };
  return `/* ${head} */

:root {
${roles("dark")}
  --sans: '${t.font.sans}', 'Helvetica Neue', Arial, sans-serif;
  --mono: '${t.font.mono}', ui-monospace, Menlo, monospace;
${Object.entries(t.radius).map(([k, v]) => `  --radius-${kebab(k)}: ${v}px;`).join("\n")}
${Object.entries(t.type.desktop).map(([k, [size, line]]) => `  --size-${k}: ${size}px; --line-${k}: ${line}px;`).join("\n")}
${t.space.map((/** @type {number} */ v, /** @type {number} */ i) => `  --space-${i}: ${v}px;`).join("\n")}
${Object.entries(t.control).map(([k, v]) => `  --control-${kebab(k)}: ${v}px;`).join("\n")}
${Object.entries(t.motion).filter(([k]) => k !== "ease").map(([k, v]) => `  --motion-${k}: ${v}ms;`).join("\n")}
  --ease: cubic-bezier(${t.motion.ease.join(", ")});
  color-scheme: dark;
}
:root[data-theme="paper"] {
${roles("paper")}
  color-scheme: light;
}
/* On a phone (under 720 wide, or a phone in landscape) the read and title steps are larger (iOS body
   size, no zoom on focus). */
@media (max-width: ${t.layout.breakpoints.medium - 1}px), (max-height: 500px) and (pointer: coarse) {
  :root {
${Object.entries(t.type.phone).filter(([k, v]) => v.join() !== t.type.desktop[k].join()).map(([k, [size, line]]) => `    --size-${k}: ${size}px; --line-${k}: ${line}px;`).join("\n")}
  }
}
`;
}

// ---- overrides ----

/** Top-level groups an override may touch. color is limited to color.dark and color.paper. */
export const ALLOWED = ["color", "font", "type", "space", "radius", "control", "motion", "shadow", "popover"];
const COLOR_THEMES = ["dark", "paper"];

/**
 * The dark swatch names config.theme.colors has always used, and the roles they paint (the same
 * map core/config/theme.js applies to /theme.css). A role config names itself wins over a swatch.
 * @type {Record<string, string[]>}
 */
const SWATCHES = {
  graphite: ["bg"], carbon: ["panel"], raised: ["hover"], bone: ["text"], stone: ["text2"], ash: ["label"],
  signal: ["primaryBg", "focus", "markDot"], signalHover: ["primaryHover"], signalInk: ["primaryInk"],
};
const ALIAS = /** @type {Record<string, string>} */ ({ beaconInk: "beacon", beaconDot: "beacon" });

/**
 * The legacy config.theme.colors (the Deck's custom-property names, with or without their dashes,
 * dark and light) as an override, for one release. Dark swatch names (graphite, bone, signal)
 * map to the roles they paint. With the shipped tokens as `base`, a name that is no role comes
 * back in `unknown` and is left out; without it, only a name that is not a custom-property name is.
 * @param {{ dark?: Record<string, string>, light?: Record<string, string>, paper?: Record<string, string> }} colors
 * @param {any} [base]
 */
export function fromLegacy(colors, base) {
  const camel = (/** @type {string} */ name) => name.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  /** @type {{ color: Record<string, Record<string, string>> }} */
  const out = { color: {} };
  /** @type {string[]} */
  const unknown = [];
  for (const [scheme, key] of [["dark", "dark"], ["light", "paper"], ["paper", "paper"]]) {
    const set = /** @type {any} */ (colors || {})[scheme];
    if (!set || typeof set !== "object") continue;
    const roles = out.color[key] || (out.color[key] = {});
    const named = [], swatched = [];
    for (const [name, value] of Object.entries(set)) {
      if (!/^(--)?[a-z][a-z0-9-]*$/.test(name)) { unknown.push(name); continue; }
      const r = camel(name);
      if (key === "dark" && SWATCHES[r]) { swatched.push(...SWATCHES[r].map(role => [role, value])); continue; }
      const role = ALIAS[r] || r;
      if (base && !(role in base.color[key])) { unknown.push(name); continue; }
      named.push([role, value]);
    }
    for (const [role, value] of swatched) roles[role] = value;
    for (const [role, value] of named) roles[role] = value;
    if (!Object.keys(roles).length) delete out.color[key];
  }
  return { override: out, unknown };
}

/**
 * Deep-merge an override over the shipped tokens, refusing keys the tokens do not have and groups
 * that may not change. Returns the merged tokens and the problems (empty means accepted).
 * @param {any} base the shipped tokens.json
 * @param {any} override the partial file
 */
export function applyOverride(base, override) {
  /** @type {string[]} */
  const problems = [];
  const merged = structuredClone(base);
  if (override !== undefined && override !== null && (typeof override !== "object" || Array.isArray(override))) {
    return { tokens: merged, problems: ["an override must be an object shaped like tokens.json"] };
  }
  for (const [group, value] of Object.entries(override || {})) {
    if (group === "$schema") continue;
    if (!ALLOWED.includes(group)) { problems.push(`${group} may not be overridden`); continue; }
    if (group === "color") {
      if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push("color must be an object"); continue; }
      for (const [scheme, roles] of Object.entries(value)) {
        if (!COLOR_THEMES.includes(scheme)) { problems.push(`color.${scheme} may not be overridden`); continue; }
        if (!roles || typeof roles !== "object" || Array.isArray(roles)) { problems.push(`color.${scheme} must be an object`); continue; }
        for (const [role, v] of Object.entries(roles)) {
          if (!(role in base.color[scheme])) { problems.push(`color.${scheme}.${role} is not a colour role`); continue; }
          try { if (typeof v !== "string") throw new Error(); rgba(v); } catch { problems.push(`color.${scheme}.${role}: ${JSON.stringify(v)} is not a colour`); continue; }
          merged.color[scheme][role] = v;
        }
      }
      continue;
    }
    merge(base[group], merged, group, value, group, problems);
  }
  return { tokens: merged, problems: problems.concat(check(merged)) };
}

/** @param {any} baseValue @param {any} parent @param {string} key @param {any} value @param {string} at @param {string[]} problems */
function merge(baseValue, parent, key, value, at, problems) {
  if (baseValue === undefined) { problems.push(`${at} is not a token`); return; }
  const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);
  if (isObj(baseValue)) {
    if (!isObj(value)) { problems.push(`${at} must be an object`); return; }
    for (const [k, v] of Object.entries(value)) merge(baseValue[k], parent[key], k, v, `${at}.${k}`, problems);
    return;
  }
  if (Array.isArray(baseValue) !== Array.isArray(value) || (!Array.isArray(value) && typeof value !== typeof baseValue)) {
    problems.push(`${at} must be ${Array.isArray(baseValue) ? "a list" : `a ${typeof baseValue}`}`);
    return;
  }
  // A list keeps the shape of the shipped one: a type step stays [size, line], space stays numbers.
  if (Array.isArray(value) && baseValue.length && value.some(v => typeof v !== typeof baseValue[0])) {
    problems.push(`${at} must be a list of ${typeof baseValue[0]}s`);
    return;
  }
  parent[key] = value;
}

// ---- the rules on the merged result ----

/** @param {number[]} top @param {number[]} under */
const over = (top, under) => {
  const a = top[3] + under[3] * (1 - top[3]);
  return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
};
/** @param {number[]} c */
const lum = c => {
  const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast of fg over bg, where either may be translucent over `under`. @param {string} fg @param {string} bg @param {string|null} [under] */
export function contrast(fg, bg, under) {
  const ground = under ? over(rgba(bg), rgba(under)) : rgba(bg);
  const text = over(rgba(fg), ground);
  const [x, y] = [lum(text), lum(ground)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Pairs the surfaces draw: [text role, ground role, ground-under role or null, minimum]. */
export const PAIRS = [
  ...["bg", "panel", "hover", "codeBg"].flatMap(g => [["text", g, null, 4.5], ["text2", g, null, 4.5]]),
  ["label", "bg", null, 4.5], ["label", "panel", null, 4.5],
  ["primaryInk", "primaryBg", null, 4.5], ["primaryInk", "primaryHover", null, 4.5],
  ["primaryInk", "beacon", null, 4.5],
  ["beacon", "bg", null, 4.5], ["beacon", "panel", null, 4.5],
  ["text", "signalWash", "panel", 4.5], ["text2", "signalWash", "panel", 4.5], ["text2", "signalWash", "bg", 4.5],
  ["text2", "delWash", "codeBg", 4.5],
  ["focus", "bg", null, 3], ["focus", "panel", null, 3],
];

/** Every rule a merged theme must keep. Returns problems, each naming what failed. @param {any} t */
export function check(t) {
  const out = [];
  for (const scheme of COLOR_THEMES) {
    const c = t.color[scheme];
    for (const [fg, bg, under, min] of PAIRS) {
      const r = contrast(c[fg], c[bg], under ? c[under] : null);
      if (r < min) out.push(`${scheme}: ${fg} on ${bg}${under ? ` over ${under}` : ""} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
    // The attention colour is one role: nothing else may wear it.
    for (const other of ["primaryBg", "primaryHover", "focus", "text", "text2", "label", "markDot"])
      if (c[other].toLowerCase() === c.beacon.toLowerCase()) out.push(`${scheme}: beacon (attention) is reused as ${other}`);
  }
  const sizes = [...Object.values(t.type.desktop), ...Object.values(t.type.phone)].map(([s]) => s).concat(t.type.mono);
  for (const s of sizes) if (s < 12) out.push(`type: ${s} is under the 12 pt minimum`);
  for (const k of ["touch", "touchLg"]) if (t.control[k] < 44) out.push(`control.${k}: ${t.control[k]} is under the 44 pt touch target`);
  for (const k of ["sans", "mono"]) if (typeof t.font[k] !== "string" || !t.font[k].trim()) out.push(`font.${k} is empty`);
  return out;
}

// ---- Deck v2 ----

/** The v2 pairs the surfaces draw: [text role, ground role, ground-under role or null, minimum]. */
export const PAIRS_V2 = [
  ...["bg", "surface1", "surface2", "surface3", "codeBg"].flatMap(g => [["text", g, null, 4.5], ["text2", g, null, 4.5]]),
  ...["bg", "surface1", "surface2", "surface3"].map(g => ["label", g, null, 4.5]),
  ["primaryInk", "primary", null, 4.5], ["primaryInk", "primaryHover", null, 4.5], ["accentInk", "accent", null, 4.5],
  ["accent", "bg", null, 4.5],
  ...["accent", "ok", "warn", "err"].flatMap(r => ["surface1", "surface2"].map(g => [r, g, null, 4.5])),
  // A status word on its own wash, over the card it sits on.
  ["accent", "accentWash", "surface2", 4.5], ["ok", "okWash", "surface2", 4.5], ["warn", "warnWash", "surface2", 4.5], ["err", "errWash", "surface2", 4.5],
  ["text", "selected", "surface2", 4.5], ["text2", "selected", "surface2", 4.5],
];

/**
 * The rules the v2 colours keep, in both schemes: every text and ground pair above at its minimum,
 * and the accent worn by no other role. The v2 group is not overridable yet, so this runs on the
 * shipped tokens. Returns problems, each naming what failed. @param {any} t
 */
export function checkV2(t) {
  /** @type {string[]} */
  const out = [];
  for (const scheme of COLOR_THEMES) {
    const c = t.v2.color[scheme];
    for (const [fg, bg, under, min] of PAIRS_V2) {
      const r = contrast(c[fg], c[bg], under ? c[under] : null);
      if (r < min) out.push(`v2 ${scheme}: ${fg} on ${bg}${under ? ` over ${under}` : ""} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
    for (const other of ["primary", "text", "text2", "label", "ok", "warn", "err"])
      if (c[other].toLowerCase() === c.accent.toLowerCase()) out.push(`v2 ${scheme}: accent is reused as ${other}`);
  }
  const sizes = [...Object.values(t.v2.type.desktop), ...Object.values(t.v2.type.phone)].map(s => (Array.isArray(s) ? s[0] : s));
  for (const s of sizes) if (s < 11) out.push(`v2 type: ${s} is under the 11 pt minimum`);
  for (const k of ["touch", "touchLg"]) if (t.v2.control[k] < 44) out.push(`v2 control.${k}: ${t.v2.control[k]} is under the 44 pt touch target`);
  return out;
}
