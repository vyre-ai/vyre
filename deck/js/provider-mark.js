// @ts-check
// The provider badge (docs/design/system/components/provider-badge.md): the small circular tile that says which AI
// account wrote a reply, holding the provider's own official mark at 62 percent (provider-art.js). An unknown provider has no mark and gets a monogram tile. Everything that draws a provider goes
// through providerMark(), so a change of look is a change in this file only.
import { h } from "./dom.js";
import * as ART from "./provider-art.js";

const parser = new DOMParser();
/** SVG text to a node. These constants are the only markup parsed here. @param {string} src */
const parseSvg = src => /** @type {SVGElement} */ (document.importNode(parser.parseFromString(src, "image/svg+xml").documentElement, true));

/** @type {Record<string, { name: string, mono: string, dark?: string, paper?: string }>} */
const KNOWN = {
  claude: { name: "Claude", mono: "Cl", dark: ART.CLAUDE, paper: ART.CLAUDE },
  codex: { name: "Codex", mono: "Cx", dark: ART.OPENAIDARK, paper: ART.OPENAIPAPER },
  openrouter: { name: "OpenRouter", mono: "Or", dark: ART.OPENROUTERDARK, paper: ART.OPENROUTERPAPER },
  grok: { name: "Grok", mono: "Gk", dark: ART.GROKDARK, paper: ART.GROKPAPER },
};

/** The provider's display name: "codex" is "Codex", an unknown one is capitalised as given. @param {string|null|undefined} provider */
export function providerName(provider) {
  const k = String(provider || "").toLowerCase();
  return KNOWN[k]?.name || (k ? k[0].toUpperCase() + k.slice(1) : "");
}

/** Beside an avatar the badge is 55 percent of it, rounded, never under 12. @param {number} avatar */
export const badgeSize = avatar => Math.max(12, Math.round(avatar * 0.55));

/**
 * The mark. Nothing is drawn without a provider: a turn that does not say who wrote it gets no badge, never a guess.
 * Both theme variants are drawn and the stylesheet shows the one that fits (dark by default, paper under [data-theme="paper"]).
 * @param {string|null|undefined} provider @param {number} [size] @param {{ model?: string|null }} [o] the model, for the accessible name only
 * @returns {HTMLElement|null}
 */
export function providerMark(provider, size = 18, o = {}) {
  const key = String(provider || "").toLowerCase().trim();
  if (!key) return null;
  const k = KNOWN[key];
  const who = providerName(key) + (o.model ? `, ${o.model}` : "");
  const props = { class: `pmark${k?.dark ? " pmark-art" : ""}`, role: "img", "aria-label": `Written by ${who}`, "data-provider": key,
    style: { width: size + "px", height: size + "px", fontSize: Math.max(7, Math.round(size * 0.44)) + "px" } };
  if (k?.dark && k.paper) {
    const dark = h("span", { class: "pmark-dark", "aria-hidden": "true" });
    dark.append(parseSvg(k.dark));
    if (k.paper === k.dark) return h("span", props, dark);
    props.class += " pmark-two";
    const paper = h("span", { class: "pmark-paper", "aria-hidden": "true" });
    paper.append(parseSvg(k.paper));
    return h("span", props, dark, paper);
  }
  const mono = k ? k.mono : key.slice(0, 2).replace(/^./, c => c.toUpperCase());
  return h("span", props, h("span", { "aria-hidden": "true" }, mono));
}
