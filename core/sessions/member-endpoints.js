// @ts-check
// The addresses a member's API key may be sent to. A member is not the box's owner, so the server will not let their call reach an address of their own choosing (a service on this machine, or
// any other https host): only the provider's own address, and xAI's one address for an OpenAI-style key. The owner is not held to this (endpointOk's own checks apply). Pure.

/** The address each key kind is sent to by default, with no base_url at all. */
export const KIND_BASE = Object.freeze({ "openai-compatible": "https://api.openai.com/v1", "anthropic-compatible": "https://api.anthropic.com", openrouter: "https://openrouter.ai/api/v1" });

/** The addresses a member may name for a key kind: the kind's own, and xAI's for an OpenAI-style key. @param {string} kind */
export function memberBases(kind) {
  const own = /** @type {Record<string, string>} */ (KIND_BASE)[kind];
  return own ? [own, ...(kind === "openai-compatible" ? ["https://api.x.ai/v1"] : [])] : [];
}

/** The addresses a member's api-key ACCOUNT may name, by its provider (what sessions.accounts.add takes). @param {string} provider */
export function memberAccountBases(provider) {
  return provider === "openai-compatible" ? memberBases("openai-compatible") : provider === "claude" ? [KIND_BASE["anthropic-compatible"]] : provider === "openrouter" ? [KIND_BASE.openrouter] : [];
}

/** Whether a member may name this address: absent is fine (the kind's own), else it must be one of the allowed, ignoring a trailing slash and case of the host. @param {unknown} baseUrl @param {readonly string[]} allowed */
export function memberBaseOk(baseUrl, allowed) {
  if (baseUrl === undefined || baseUrl === null || baseUrl === "") return true;
  const t = String(baseUrl).trim().replace(/\/+$/, "").toLowerCase();
  return allowed.some((a) => a.toLowerCase() === t);
}
