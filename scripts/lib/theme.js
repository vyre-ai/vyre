// @ts-check
// Theme overrides (ADR 0033 section 3): a partial tokens.json from the person
// (<home>/overrides/theme.json) or a module's themes/<name>.json, deep-merged over the shipped
// tokens. Objects merge by key; arrays and plain values replace. The merged result must keep the
// rules every surface relies on, and one failure refuses the whole file.
import { rgba } from "./tokens.js";

/** Top-level groups an override may touch. color is limited to color.dark and color.paper. */
export const ALLOWED = ["color", "font", "type", "space", "radius", "control", "motion", "shadow", "popover"];
const COLOR_THEMES = ["dark", "paper"];

/**
 * The legacy config.theme.colors (CSS custom-property names, dark and light) as an override, for
 * one release. Unknown names come back in `unknown`; the caller refuses them.
 * @param {{ dark?: Record<string, string>, light?: Record<string, string> }} colors
 */
export function fromLegacy(colors) {
  const role = name => name.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const alias = { beaconInk: "beacon", beaconDot: "beacon" };
  const out = { color: {} }, unknown = [];
  for (const [scheme, key] of [["dark", "dark"], ["light", "paper"]]) {
    if (!colors[scheme]) continue;
    out.color[key] = {};
    for (const [name, value] of Object.entries(colors[scheme])) {
      const r = alias[role(name)] || role(name);
      out.color[key][r] = value;
      if (!/^--/.test(name)) unknown.push(name);
    }
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
  const problems = [];
  const merged = structuredClone(base);
  for (const [group, value] of Object.entries(override || {})) {
    if (group === "$schema") continue;
    if (!ALLOWED.includes(group)) { problems.push(`${group} may not be overridden`); continue; }
    if (group === "color") {
      for (const [scheme, roles] of Object.entries(value || {})) {
        if (!COLOR_THEMES.includes(scheme)) { problems.push(`color.${scheme} may not be overridden`); continue; }
        for (const [role, v] of Object.entries(roles || {})) {
          if (!(role in base.color[scheme])) { problems.push(`color.${scheme}.${role} is not a colour role`); continue; }
          try { rgba(v); } catch { problems.push(`color.${scheme}.${role}: ${JSON.stringify(v)} is not a colour`); continue; }
          merged.color[scheme][role] = v;
        }
      }
      continue;
    }
    merge(base[group], merged, group, value, group, problems);
  }
  return { tokens: merged, problems: problems.concat(check(merged)) };
}

function merge(baseValue, parent, key, value, at, problems) {
  if (baseValue === undefined) { problems.push(`${at} is not a token`); return; }
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  if (isObj(baseValue)) {
    if (!isObj(value)) { problems.push(`${at} must be an object`); return; }
    for (const [k, v] of Object.entries(value)) merge(baseValue[k], parent[key], k, v, `${at}.${k}`, problems);
    return;
  }
  if (Array.isArray(baseValue) !== Array.isArray(value) || (!Array.isArray(value) && typeof value !== typeof baseValue)) {
    problems.push(`${at} must be ${Array.isArray(baseValue) ? "a list" : `a ${typeof baseValue}`}`);
    return;
  }
  parent[key] = value;
}

// ---- the rules on the merged result ----

const over = (top, under) => {
  const a = top[3] + under[3] * (1 - top[3]);
  return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
};
const lum = c => {
  const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast of fg over bg, where either may be translucent over `under`. */
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

/** Every rule a merged theme must keep. Returns problems, each naming what failed. */
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
