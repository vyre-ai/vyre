// @ts-check
// windows — how big a model's context window is, by its name, for a session that has not reported its own (core/switchboard/rollover.js, core/harness/meter.js).

/**
 * Context windows by model, for a session that has not reported its own. First match wins. The
 * agents report their own window when they can (Claude's result, Codex's usage_update); this is the
 * floor under a count made from characters.
 * @type {[RegExp, number][]}
 */
export const WINDOWS = [
  [/\[1m\]|[-_]1m\b|\b1m\b/i, 1_000_000],
  [/gemini/i, 1_000_000],
  [/grok/i, 256_000],
  [/gpt-?5|codex|\bo[134]\b/i, 258_400],
  [/claude|opus|sonnet|haiku/i, 200_000],
];
export const DEFAULT_WINDOW = 128_000;

/** @param {string|null|undefined} model @param {string|null|undefined} [provider] */
export function windowFor(model, provider) {
  const hay = `${model || ""} ${provider && provider !== "claude" ? provider : ""}`;
  for (const [re, n] of WINDOWS) if (re.test(hay)) return n;
  return provider === "claude" || (!model && !provider) ? 200_000 : DEFAULT_WINDOW;
}
