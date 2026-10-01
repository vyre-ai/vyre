// @ts-check
// The evaluation's recording runner through OpenRouter, with a hard spend stop. It replaces
// `claude -p` only when VYRE_EVAL_RUNNER=openrouter (the memory-eval-record workflow), takes its
// key from OPENROUTER_EVAL_KEY and never prints it. Cost comes from OpenRouter's own usage.cost
// on each reply. The running total is kept in a file, so a rerun continues where it stopped.

import fs from "node:fs";
import path from "node:path";

export const LIMIT_USD = 15;
/** Headroom kept under the limit: a call is refused when total + margin would pass it. */
export const MARGIN_USD = 0.05;
/** The most one call can cost, per model (a long prompt on a dear model): the margin kept for it. */
export const MARGIN_BY_MODEL = { "anthropic/claude-haiku-4.5": 0.05, "anthropic/claude-sonnet-4.6": 0.25 };
/** The margin for a model: its own maximum, and the dearest known one for a model not listed. @param {string} [model] */
export const marginFor = model => (model && MARGIN_BY_MODEL[model]) || Math.max(...Object.values(MARGIN_BY_MODEL));
export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** The key's own usage, from OpenRouter: the authority on what the key has spent, whatever this repository's ledger says. */
export const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
/** A run refuses to start when the key has already spent this much (the user's total is about $15; the key's own hard limit is higher). */
export const START_LIMIT_USD = 14;

/** The spend limit was reached: recordings so far are saved, the run stops. */
export class BudgetStop extends Error {
  /** @param {number} total @param {number} limit */
  constructor(total, limit) {
    super(`spend stop: $${total.toFixed(4)} spent, the next call could pass the $${limit} limit; recordings so far are saved, rerun to continue`);
    this.code = "budget";
  }
}

/**
 * What the key has spent and is allowed, read from OpenRouter with the key itself. Never logs or returns the key; any failure
 * throws, so a caller that cannot tell the usage does not start.
 * @param {{ key: string, fetch?: typeof fetch, endpoint?: string }} o @returns {Promise<{ usage: number, limit: number | null }>}
 */
export async function keyUsage(o) {
  if (!o.key) throw new Error("OPENROUTER_EVAL_KEY is not set");
  let res, j = null;
  try {
    res = await (o.fetch || fetch)(o.endpoint || KEY_ENDPOINT, { headers: { authorization: `Bearer ${o.key}` } });
    j = await res.json();
  } catch { throw new Error("could not read the key's usage from OpenRouter"); }
  const usage = Number(j && j.data && j.data.usage);
  if (!res.ok || !Number.isFinite(usage)) throw new Error(`could not read the key's usage from OpenRouter (${res.status})`);
  const limit = j.data.limit == null ? null : Number(j.data.limit);
  return { usage, limit: Number.isFinite(limit) ? limit : null };
}

export const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

/**
 * Is this model still on OpenRouter? Its model list is public (no key). OpenRouter answers a retired id with a 400 that Grok Build shows
 * as "Internal error" (x-ai/grok-code-fast-1, retired, did exactly that in the meter spike), so a proof asks first. null when the list
 * cannot be read: unknown, not a reason to stop.
 * @param {string} slug @param {{ fetch?: typeof fetch, endpoint?: string }} [o] @returns {Promise<boolean|null>}
 */
export async function modelListed(slug, o = {}) {
  try {
    const res = await (o.fetch || fetch)(o.endpoint || MODELS_ENDPOINT);
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j && j.data) ? j.data.some(/** @param {any} m */ m => m && m.id === slug) : null;
  } catch { return null; }
}

/** A run that may not start: the key has already spent START_LIMIT_USD. */
export class StartRefused extends Error {
  /** @param {number} usage */
  constructor(usage) { super(`refusing to start: the key has already spent $${usage.toFixed(4)} (a run starts only below $${START_LIMIT_USD})`); this.code = "budget"; }
}

/** A running total of spend, persisted after every call. */
export class Budget {
  /** @param {{ file?: string|null, limit?: number, margin?: number }} [o] */
  constructor(o = {}) {
    this.file = o.file || null;
    this.limit = o.limit ?? LIMIT_USD;
    this.margin = o.margin ?? MARGIN_USD;
    this.total = 0;
    this.calls = 0;
    this.stopped = false;
    /** What the key had spent when this run started (from OpenRouter), and what this run has added since: the key's own cap. */
    this.keyBase = /** @type {number|null} */ (null);
    this.run = 0;
    /** The call count at which the key's usage was last re-read. */
    this.refreshedAt = 0;
    if (this.file && fs.existsSync(this.file)) {
      try { const j = JSON.parse(fs.readFileSync(this.file, "utf8")); this.total = Number(j.usd) || 0; this.calls = Number(j.calls) || 0; } catch { /* a bad file starts at zero, never higher than the truth is safe: fail closed below */ this.total = this.limit; }
    }
  }
  /** Throws BudgetStop when one more call could pass the limit. */
  check() {
    if (this.total + this.margin > this.limit) { this.stopped = true; throw new BudgetStop(this.total, this.limit); }
    // The key's own usage counts too: earlier spend that never reached the committed ledger still counts against the total.
    if (this.keyBase != null && this.keyBase + this.run + this.margin > this.limit) { this.stopped = true; throw new BudgetStop(this.keyBase + this.run, this.limit); }
  }
  /** @param {number} usage what the key had spent before this run */
  setKeyBase(usage) { this.keyBase = Math.max(0, Number(usage) || 0); }
  /** @param {number} usd */
  add(usd) {
    this.total += Math.max(0, Number(usd) || 0);
    this.run += Math.max(0, Number(usd) || 0);
    this.calls++;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ usd: Math.round(this.total * 1e6) / 1e6, calls: this.calls, limit: this.limit }) + "\n");
    }
  }
}

/**
 * A runner with claudeOnce's shape: ({ system, prompt, model, maxUsd }) -> { text, usd, tokens_in, tokens_out }.
 * @param {{ key: string, model?: string, budget: Budget, fetch?: typeof fetch, endpoint?: string, refreshEvery?: number, keyEndpoint?: string }} o
 *   refreshEvery: re-read the key's usage from OpenRouter every this many calls (default 20), so spend by anything else on the same key is seen.
 */
export function openrouterOnce(o) {
  if (!o.key) throw new Error("OPENROUTER_EVAL_KEY is not set");
  const doFetch = o.fetch || fetch;
  const every = o.refreshEvery ?? 20;
  return async ({ system, prompt, model, maxTokens }) => {
    // A key base read once goes stale: something else can spend on the same key mid-run. Re-read it every N calls, and stop when it cannot be read.
    if (o.budget.keyBase != null && every > 0 && o.budget.calls > 0 && o.budget.calls % every === 0 && o.budget.refreshedAt !== o.budget.calls) {
      try { const u = await keyUsage({ key: o.key, fetch: doFetch, ...(o.keyEndpoint ? { endpoint: o.keyEndpoint } : {}) }); o.budget.setKeyBase(u.usage); o.budget.run = 0; o.budget.refreshedAt = o.budget.calls; }
      catch { o.budget.stopped = true; throw new BudgetStop(o.budget.total, o.budget.limit); }
    }
    o.budget.check();
    const res = await doFetch(o.endpoint || ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: o.model || model, usage: { include: true }, temperature: 0, ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    let j;
    try { j = await res.json(); } catch { j = null; }
    // Spend is counted even when the reply is unusable: the money is gone.
    const usd = Number(j && j.usage && j.usage.cost) || 0;
    if (usd) o.budget.add(usd);
    if (!res.ok || !j || j.error) throw new Error(`OpenRouter ${res.status}: ${String((j && j.error && j.error.message) || "no reply").slice(0, 160)}`);
    if (!usd) o.budget.add(0.002); // no cost reported: assume a small amount, never free
    const u = j.usage || {};
    return { text: String(j.choices?.[0]?.message?.content || ""), usd, tokens_in: Number(u.prompt_tokens || 0), tokens_out: Number(u.completion_tokens || 0) };
  };
}
