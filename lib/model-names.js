// @ts-check
// The model names of each API-key account, asked of the inference door (R031-84): the switchboard hands the daemon the key of one account for one request (`accountKey`), the door's driver asks the provider and
// answers names only. Nothing here holds, returns or logs a key.

/** The providers whose own model list can be asked (the door's drivers: core/daemon/model-lists.js). */
export const MODEL_LISTING_PROVIDERS = Object.freeze(["claude", "codex", "grok", "openai-compatible"]);

/** The key of one API-key account: the first non-empty value of its launch environment. @param {(a: any) => Promise<{ env?: Record<string, any> }>} accountEnv */
export const keyOfAccount = accountEnv => async (/** @type {any} */ a) => {
  const c = await accountEnv(a);
  const key = Object.values((c && c.env) || {}).find(v => typeof v === "string" && v);
  return typeof key === "string" ? key : null;
};

/**
 * Each API-key account's model names, as { provider, account, ok: true, models: [name] } or { provider, account, ok: false, error }.
 * @param {any} ctx the module's context (call, listModels) @param {readonly string[]} providers
 */
export async function modelNames(ctx, providers) {
  /** @type {any[]} */ const out = [];
  for (const provider of providers) {
    const l = /** @type {any} */ (await ctx.call("sessions.accounts.list", { provider }).catch(() => null));
    const rows = l && !l.error && Array.isArray(l.data) ? l.data : [];
    for (const a of rows.filter((/** @type {any} */ x) => x && x.kind === "api-key")) {
      const base = { provider, account: String(a.id) };
      try {
        if (typeof ctx.listModels !== "function") { out.push({ ...base, ok: false, error: "no way to ask the door for a model list here" }); continue; }
        out.push({ ...base, ok: true, models: await ctx.listModels({ provider, account: a }) });
      } catch (e) { out.push({ ...base, ok: false, error: e instanceof Error ? e.message.slice(0, 100) : "could not be read" }); }
    }
  }
  return out;
}
