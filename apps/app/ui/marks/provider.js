// @ts-check
// The provider badge (docs/design/system/components/provider-badge.md): which AI account wrote a reply, drawn with the provider's own published mark (./provider-art.js, copied unmodified from the old Deck, never Vyre's own branding).
// Pure: the markup and the names, no DOM and no React. An unknown provider has no mark and gets a monogram; a reply that does not say who wrote it gets nothing, never a guess.
import * as ART from "./provider-art.js";

/** @type {Record<string, { name: string, mono: string, dark?: string, paper?: string }>} */
const KNOWN = {
  claude: { name: "Claude", mono: "Cl", dark: ART.CLAUDE, paper: ART.CLAUDE },
  codex: { name: "Codex", mono: "Cx", dark: ART.OPENAIDARK, paper: ART.OPENAIPAPER },
  openrouter: { name: "OpenRouter", mono: "Or", dark: ART.OPENROUTERDARK, paper: ART.OPENROUTERPAPER },
  grok: { name: "Grok", mono: "Gk", dark: ART.GROKDARK, paper: ART.GROKPAPER },
};

/** "codex" is "Codex", an unknown one is capitalised as given. @param {string | null | undefined} provider */
export function providerName(provider) {
  const k = String(provider || "").toLowerCase().trim();
  return KNOWN[k]?.name || (k ? k[0].toUpperCase() + k.slice(1) : "");
}

/** The mark's SVG for a scheme, or null (an unknown provider, or none). @param {string | null | undefined} provider @param {"dark" | "paper"} [scheme] */
export function providerArt(provider, scheme = "dark") {
  const k = KNOWN[String(provider || "").toLowerCase().trim()];
  return k ? (scheme === "paper" ? k.paper : k.dark) ?? null : null;
}

/** The monogram of a provider without art. @param {string | null | undefined} provider */
export function providerMono(provider) {
  const key = String(provider || "").toLowerCase().trim();
  return KNOWN[key]?.mono ?? key.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/** The provider a model's name belongs to, when the name says so; otherwise null (no guess). @param {string | null | undefined} model */
export function providerOfModel(model) {
  const m = String(model || "").toLowerCase();
  if (/claude|sonnet|opus|haiku|fable/.test(m)) return "claude";
  if (/gpt|codex|\bo[134]\b/.test(m)) return "codex";
  if (/grok/.test(m)) return "grok";
  return null;
}

/** Beside an avatar the badge is 55 percent of it, never under 12. @param {number} avatar */
export const badgeSize = (avatar) => Math.max(12, Math.round(avatar * 0.55));

/** The words for the badge's accessible name. @param {string | null | undefined} provider @param {string | null | undefined} [model] */
export const badgeLabel = (provider, model) => `Written by ${providerName(provider)}${model ? `, ${model}` : ""}`;
