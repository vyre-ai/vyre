// @ts-check
// The AI providers as the app draws them (docs/design/system/components/provider-badge.md): each one's name, the company behind it, and its brand mark from the app's one icon set
// (src/ui/icons.source.json: logo-claude, logo-openai, logo-grok, logo-openrouter, monochrome and tinted with the theme's ink, so they read in light and dark). OpenAI-compatible is any key, so it gets the
// key icon. Every provider is drawn the same way; none comes first. Pure: names and icon names, no DOM and no React. An unknown provider has no mark and gets a monogram; a reply that does not say
// who wrote it gets nothing, never a guess.

/** @type {Record<string, { name: string, vendor: string, mono: string, icon: string }>} */
const KNOWN = {
  claude: { name: "Claude", vendor: "Anthropic", mono: "Cl", icon: "logo-claude" },
  codex: { name: "Codex", vendor: "OpenAI", mono: "Cx", icon: "logo-openai" },
  grok: { name: "Grok", vendor: "xAI", mono: "Gk", icon: "logo-grok" },
  openrouter: { name: "OpenRouter", vendor: "OpenRouter", mono: "Or", icon: "logo-openrouter" },
  "openai-compatible": { name: "OpenAI-compatible", vendor: "Any key", mono: "Ok", icon: "key" },
  opencode: { name: "OpenCode", vendor: "OpenCode", mono: "Oc", icon: "spark" },
};

const known = (/** @type {string | null | undefined} */ provider) => KNOWN[String(provider || "").toLowerCase().trim()];

/** "codex" is "Codex", an unknown one is capitalised as given. @param {string | null | undefined} provider */
export function providerName(provider) {
  const k = String(provider || "").toLowerCase().trim();
  return known(k)?.name || (k ? k[0].toUpperCase() + k.slice(1) : "");
}

/** The company behind a provider ("Anthropic" for Claude), or "" for one the app does not know. @param {string | null | undefined} provider */
export const providerVendor = (provider) => known(provider)?.vendor ?? "";

/** The provider's mark in the icon set (a name of src/ui/icons.generated.ts), or null for an unknown provider or none. @param {string | null | undefined} provider */
export const providerIcon = (provider) => known(provider)?.icon ?? null;

/** The monogram of a provider without a mark. @param {string | null | undefined} provider */
export function providerMono(provider) {
  const key = String(provider || "").toLowerCase().trim();
  return known(key)?.mono ?? key.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
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
