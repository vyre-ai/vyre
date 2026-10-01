// @ts-check
// The provider badge (docs/design/system/components/provider-badge.md): the small mark that says which AI
// account wrote a reply. Neutral stand-ins in the provider's own shape, so it never relies on colour, until the
// vendors' own marks are allowed. Everything that draws a provider goes through providerMark(), so swapping the
// look is a change in this file only. A provider this file does not know gets a circle with its first two letters.
import { h } from "./dom.js";

/** @type {Record<string, { name: string, mono: string, shape: "circle"|"square"|"drop" }>} */
const KNOWN = {
  claude: { name: "Claude", mono: "Cl", shape: "circle" },
  codex: { name: "Codex", mono: "Cx", shape: "square" },
  grok: { name: "Grok", mono: "Gk", shape: "drop" },
};

/** The provider's display name: "codex" is "Codex", an unknown one is capitalised as given. @param {string|null|undefined} provider */
export function providerName(provider) {
  const k = String(provider || "").toLowerCase();
  return KNOWN[k]?.name || (k ? k[0].toUpperCase() + k.slice(1) : "");
}

/** Beside an avatar the badge is 55 percent of it, never under 12. @param {number} avatar */
export const badgeSize = avatar => Math.max(12, Math.round(avatar * 0.55));

/**
 * The mark. Nothing is drawn without a provider: a turn that does not say who wrote it gets no badge, never a guess.
 * @param {string|null|undefined} provider @param {number} [size] @param {{ model?: string|null }} [o] the model, for the accessible name only
 * @returns {HTMLElement|null}
 */
export function providerMark(provider, size = 18, o = {}) {
  const key = String(provider || "").toLowerCase().trim();
  if (!key) return null;
  const k = KNOWN[key];
  const shape = k ? k.shape : "circle";
  const mono = k ? k.mono : key.slice(0, 2).replace(/^./, c => c.toUpperCase());
  const who = providerName(key) + (o.model ? `, ${o.model}` : "");
  return h("span", { class: `pmark pmark-${shape}${k ? " pmark-" + key : ""}`, role: "img", "aria-label": `Written by ${who}`, "data-provider": key,
    style: { width: size + "px", height: size + "px", fontSize: Math.max(7, Math.round(size * 0.44)) + "px" } },
    h("span", { "aria-hidden": "true" }, mono));
}
