// @ts-check
// Where each provider lists its models, and how an API key asks (R031-84). A provider's own endpoint and header names live here, so the rest of Vyre never names them. The
// caller (the switchboard) holds the key and passes it in for one request; nothing here stores or returns it.

/** @type {Record<string, { url: (a: any) => string | null, headers: (key: string) => Record<string, string> }>} */
const BY_PROVIDER = {
  claude: { url: (a) => `${a.base_url ? String(a.base_url).replace(/\/$/, "") : "https://api.anthropic.com"}/v1/models?limit=200`, headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
  codex: { url: () => "https://api.openai.com/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }) },
  grok: { url: () => "https://api.x.ai/v1/models", headers: (k) => ({ authorization: `Bearer ${k}` }) },
  "openai-compatible": { url: (a) => (a.base_url ? `${String(a.base_url).replace(/\/$/, "")}/models` : null), headers: (k) => ({ authorization: `Bearer ${k}` }) },
};

/** The providers this can ask. */
export const MODEL_LISTING_PROVIDERS = Object.freeze(Object.keys(BY_PROVIDER));

/**
 * One account's model list. Returns { provider, account, ok: true, body } or { provider, account, ok: false, error }; never the key.
 * @param {{ id: string, provider: string, base_url?: string | null }} account @param {string} key
 * @param {{ fetch: (url: string, init: any) => Promise<any>, hostSafe?: (url: string) => Promise<boolean> }} io
 */
export async function fetchModels(account, key, io) {
  const spec = BY_PROVIDER[account.provider];
  const base = { provider: account.provider, account: String(account.id) };
  if (!spec) return { ...base, ok: false, error: "this provider has no model list to ask for" };
  const url = spec.url(account);
  if (!url) return { ...base, ok: false, error: "the account names no address" };
  if (account.base_url && io.hostSafe && !(await io.hostSafe(String(account.base_url)))) return { ...base, ok: false, error: "the account's address is not a place a key may be sent now" };
  try {
    const res = await io.fetch(url, { headers: { accept: "application/json", ...spec.headers(key) }, timeoutMs: 15_000 });
    if (!res.ok) return { ...base, ok: false, error: res.status === 401 || res.status === 403 ? "the key was refused" : `HTTP ${res.status}` };
    return { ...base, ok: true, body: await res.json() };
  } catch (e) { return { ...base, ok: false, error: e instanceof Error ? e.message.slice(0, 100) : "could not be read" }; }
}
