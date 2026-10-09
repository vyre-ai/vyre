// @ts-check
// lib/tokens: the one token estimator for sizes that are budgets and not bills: a model's tokens are about a quarter of the characters of English and code. Pure, so any part may import it.
// The agent docs' budgets (docs/agents), the docs tool's page sizes and the native assistant's situation all use this same count, so a number in one place means the same in another.

/** Characters to a token: the one number every rough count in Vyre uses. */
export const CHARS_PER_TOKEN = 4;

/** @param {string} text */
export const tokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN);

/** The same count for a length already known. @param {number} chars */
export const tokensOfChars = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);
