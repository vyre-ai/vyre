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

/** The spend limit was reached: recordings so far are saved, the run stops. */
export class BudgetStop extends Error {
  /** @param {number} total @param {number} limit */
  constructor(total, limit) {
    super(`spend stop: $${total.toFixed(4)} spent, the next call could pass the $${limit} limit; recordings so far are saved, rerun to continue`);
    this.code = "budget";
  }
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
    if (this.file && fs.existsSync(this.file)) {
      try { const j = JSON.parse(fs.readFileSync(this.file, "utf8")); this.total = Number(j.usd) || 0; this.calls = Number(j.calls) || 0; } catch { /* a bad file starts at zero, never higher than the truth is safe: fail closed below */ this.total = this.limit; }
    }
  }
  /** Throws BudgetStop when one more call could pass the limit. */
  check() {
    if (this.total + this.margin > this.limit) { this.stopped = true; throw new BudgetStop(this.total, this.limit); }
  }
  /** @param {number} usd */
  add(usd) {
    this.total += Math.max(0, Number(usd) || 0);
    this.calls++;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ usd: Math.round(this.total * 1e6) / 1e6, calls: this.calls, limit: this.limit }) + "\n");
    }
  }
}

/**
 * A runner with claudeOnce's shape: ({ system, prompt, model, maxUsd }) -> { text, usd, tokens_in, tokens_out }.
 * @param {{ key: string, model?: string, budget: Budget, fetch?: typeof fetch, endpoint?: string }} o
 */
export function openrouterOnce(o) {
  if (!o.key) throw new Error("OPENROUTER_EVAL_KEY is not set");
  const doFetch = o.fetch || fetch;
  return async ({ system, prompt, model }) => {
    o.budget.check();
    const res = await doFetch(o.endpoint || ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: o.model || model, usage: { include: true }, temperature: 0,
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
