// @ts-check
// model-lists: where each provider lists its models, and how its API key asks (R031-84). The inference door's `listModels` calls these drivers; the door checks the chain and the sink and clamps the
// answer to names, and the driver alone holds the endpoint and the key slot. The key comes from `keyOf(account)` for one request and is never returned, logged or put in an error. A provider's own
// header names live here and nowhere else.

/** @type {Record<string, { url: (a: any) => string | null, headers: (key: string) => Record<string, string> }>} */
const BY_PROVIDER = {
  claude: { url: (a) => `${a.base_url ? String(a.base_url).replace(/\/$/, "") : "https://api.anthropic.com"}/v1/models?limit=200`, headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
  codex: { url: () => "https://api.openai.com/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }) },
  grok: { url: () => "https://api.x.ai/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }) },
  "openai-compatible": { url: (a) => (a.base_url ? `${String(a.base_url).replace(/\/$/, "")}/models` : null), headers: (k) => ({ authorization: `Bearer ${k}` }) },
};
/** The providers that can be asked. */
export const MODEL_LISTING_PROVIDERS = Object.freeze(Object.keys(BY_PROVIDER));

/** The model names in a provider's answer: the `id` (or `name`) of each entry of `data` or `models`, text only. @param {any} body @returns {string[]} */
export function namesOf(body) {
  const rows = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : [];
  return [...new Set(rows.map((/** @type {any} */ r) => (r && typeof r === "object" ? r.id ?? r.name : r)).filter((/** @type {any} */ n) => typeof n === "string" && n).map((/** @type {string} */ n) => n.replace(/^models\//, "")))];
}

/**
 * One driver per listable provider: `models({ account })` -> names. `call` refuses, so a provider that can only be listed is not a model the door can call.
 * @param {{ keyOf: (account: any) => Promise<string | null | undefined> | string | null | undefined, fetch: (url: string, init: any) => Promise<any>, hostSafe?: (url: string) => Promise<boolean> }} io
 */
export function modelListDrivers(io) {
  /** @type {Record<string, any>} */ const out = {};
  for (const [provider, spec] of Object.entries(BY_PROVIDER)) {
    out[provider] = {
      call: async () => { throw new Error(`${provider} can be listed here, not called`); },
      /** @param {{ account: any }} q */
      async models({ account }) {
        const a = { ...(account || {}), provider };
        const url = spec.url(a);
        if (!url) throw new Error("the account names no address");
        if (a.base_url && io.hostSafe && !(await io.hostSafe(String(a.base_url)))) throw new Error("the account's address is not a place a key may be sent now");
        const key = await io.keyOf(a);
        if (!key) throw new Error("no key");
        let res;
        try { res = await io.fetch(url, { headers: { accept: "application/json", ...spec.headers(String(key)) }, timeoutMs: 15_000 }); }
        catch (e) { throw new Error(e instanceof Error ? e.message.replaceAll(String(key), "[key]").slice(0, 100) : "could not be read"); }
        if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "the key was refused" : `HTTP ${res.status}`);
        return namesOf(await res.json());
      },
    };
  }
  return out;
}
