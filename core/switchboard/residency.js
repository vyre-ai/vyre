// @ts-check
// Which model vendors a chat may run on: one check for every provider the Switchboard starts (Claude, Codex, Grok, OpenRouter, an OpenAI-compatible endpoint), on the direct path (a subscription login that
// talks to its own vendor) and the door path alike. The person's setting `threads.vendors.allow` is the policy: empty means every vendor; a list means only those. A refused run starts nothing and says
// which vendor, in words. A policy that cannot be read is not guessed: a settings module that is there and fails refuses; one that is not there is no policy.

export const SETTING = "threads.vendors.allow";

/** The vendor behind each provider, as the person reads it. */
export const VENDORS = Object.freeze({ claude: "Anthropic (Claude)", codex: "OpenAI (Codex)", grok: "xAI (Grok)", openrouter: "OpenRouter", "openai-compatible": "an OpenAI-compatible endpoint" });

/** @param {any} value the setting @returns {Set<string> | null} the provider ids allowed, or null for no limit */
export function allowedSet(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids = raw.map(x => String(x).trim().toLowerCase()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** The words of a refusal, or null when this provider may run. @param {string} provider @param {any} value */
export function refusal(provider, value) {
  const allow = allowedSet(value);
  if (!allow || allow.has(String(provider))) return null;
  const vendor = /** @type {Record<string, string>} */ (VENDORS)[provider] || String(provider).slice(0, 40);
  const ok = [...allow].map(p => /** @type {Record<string, string>} */ (VENDORS)[p] || p).join(", ");
  return `Your settings do not allow chats on ${vendor}. Allowed: ${ok}. Change this under Model vendors allowed.`;
}

/**
 * Check a provider against the person's setting. Throws an error with code "residency" and the words.
 * @param {{ call: (tool: string, input: any) => Promise<any> }} deps the Switchboard's deps (its registry call) @param {string} provider
 */
export async function checkResidency(deps, provider) {
  let value;
  try {
    const r = await deps.call("settings.get", { key: SETTING });
    if (r && r.error && !/^(no_such_tool|not_found|missing)$/.test(String(r.error.code))) throw Object.assign(new Error("Vyre could not read which model vendors are allowed, so this chat did not start."), { code: "residency" });
    value = r && !r.error && r.data ? r.data.value : undefined;
  } catch (e) {
    if (/** @type {any} */ (e) && /** @type {any} */ (e).code === "residency") throw e;
    throw Object.assign(new Error("Vyre could not read which model vendors are allowed, so this chat did not start."), { code: "residency" });
  }
  const why = refusal(provider, value);
  if (why) throw Object.assign(new Error(why), { code: "residency" });
}
