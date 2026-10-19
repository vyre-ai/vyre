// @ts-check
// The model an AI account is kept and started with. The OpenRouter driver never picks one for a person (it would spend on their behalf), so an OpenRouter account carries one: the one named, else this default.
// One owner of the name: first run saves it through sessions.accounts.key, and a start on an account saved without one uses it too (core/switchboard/asker-account.js, through providers.js).

export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

/** The model an account is kept with: the one named, else the provider's default (only OpenRouter has one), else none. @param {string} provider @param {unknown} model @returns {string | undefined} */
export const accountModel = (provider, model) => (model ? String(model).slice(0, 100) : provider === "openrouter" ? OPENROUTER_DEFAULT_MODEL : undefined);
