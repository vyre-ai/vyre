// @ts-check
// Vyre's colours as config: `theme.colors` { dark: {...}, light: {...} } in config.json, keyed by
// the token names in docs/design/TOKENS.md without their dashes. The Deck's own stylesheet keeps
// the TOKENS defaults; GET /theme.css (core/daemon) turns whatever config overrides into custom
// properties, dark on :root and light on :root[data-theme="paper"]. A value that is not a plain
// CSS colour is dropped, so config can never add a rule, an import or a url().

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COLOUR = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

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
