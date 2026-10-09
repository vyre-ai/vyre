// @ts-check
// lib/model-registry: the pure part of the model registry (R031-84). Provider /models answers, what a CLI reported, and OpenRouter's public metadata become one list of entries; a new id is
// noticed; an eval's cost is worked out from the model's own price. No network, no storage, no clock but the one it is given.
//
// An entry: { id, provider, label, sources: string[], context, price: { in, out } | null (USD per million tokens), capabilities | null, evals, first_seen, last_seen, missed, available, from: { <field>: source } }.

/** Rank of what each source knows, highest wins a field: the provider's own answer, then what a CLI reported, then OpenRouter's description of it, then the fallback list. */
export const SOURCE_RANK = Object.freeze({ api: 4, cli: 3, openrouter: 2, fallback: 1 });
/** How many refreshes a model may be missing from every source before it is marked unavailable (it is never deleted: an eval score stays). */
export const MISSED_LIMIT = 3;
/** The providers the registry names, and the OpenRouter vendor prefix each one's models carry. */
export const PROVIDERS = Object.freeze({ claude: "anthropic", codex: "openai", grok: "x-ai", openrouter: "" });

/** @param {unknown} v @param {number} [n] */
const text = (v, n = 120) => (typeof v === "string" ? v.trim().slice(0, n) : "");
/** @param {any} v */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** The entry key. @param {string} provider @param {string} id */
export const keyOf = (provider, id) => `${provider}/${id}`;

/**
 * One provider's /models answer as plain rows. Anthropic: { data: [{ id, display_name, created_at }] }. OpenAI and xAI: { data: [{ id, created }] }. OpenRouter: { data: [{ id, name, context_length,
 * pricing: { prompt, completion } (USD per token, as strings), supported_parameters, architecture }] }. Anything else is no rows.
 * @param {string} provider @param {any} body @returns {{ id: string, label: string, context: number | null, price: { in: number, out: number } | null, capabilities: Record<string, boolean> | null, created?: number }[]}
 */
export function normalizeApi(provider, body) {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : [];
  /** @type {ReturnType<typeof normalizeApi>} */ const out = [];
  for (const r of rows.slice(0, 2000)) {
    if (!isObj(r) || typeof r.id !== "string" || !r.id) continue;
    const id = r.id.slice(0, 120);
    const label = text(r.display_name) || text(r.name) || id;
    const created = typeof r.created === "number" ? r.created * 1000 : typeof r.created_at === "string" && Date.parse(r.created_at) ? Date.parse(r.created_at) : undefined;
    if (provider === "openrouter") {
      const per = (/** @type {any} */ x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null; };
      const pin = per(r.pricing && r.pricing.prompt), pout = per(r.pricing && r.pricing.completion);
      const params = Array.isArray(r.supported_parameters) ? r.supported_parameters.map(String) : [];
      const mods = isObj(r.architecture) && Array.isArray(r.architecture.input_modalities) ? r.architecture.input_modalities.map(String) : [];
      out.push({ id, label, context: Number.isFinite(Number(r.context_length)) && Number(r.context_length) > 0 ? Number(r.context_length) : null, price: pin !== null && pout !== null ? { in: pin, out: pout } : null,
        capabilities: { tools: params.includes("tools"), reasoning: params.includes("reasoning") || params.includes("include_reasoning"), vision: mods.includes("image") }, ...(created ? { created } : {}) });
    } else out.push({ id, label, context: null, price: null, capabilities: null, ...(created ? { created } : {}) });
  }
  return out;
}

/** The key two ids of the same model share: lower case, the vendor prefix off, a date suffix off, dots and dashes the same ("claude-sonnet-4.5" and "claude-sonnet-4-5-20250929"). @param {string} id */
export function joinKey(id) {
  return String(id).toLowerCase().replace(/^[a-z0-9-]+\//, "").replace(/-(?:20\d{6}|\d{4}-\d{2}-\d{2})$/, "").replace(/-latest$/, "").replace(/[.:_]/g, "-").replace(/-+/g, "-");
}

/**
 * Merge one source's rows into the entries, field by field, the higher-ranked source winning each field it knows. Returns the new entries (a Map by key) and the keys that were not there before.
 * @param {Map<string, any>} entries @param {string} provider @param {string} source @param {ReturnType<typeof normalizeApi>} rows @param {number} at
 * @returns {{ entries: Map<string, any>, added: string[] }}
 */
export function mergeSource(entries, provider, source, rows, at) {
  const out = new Map([...entries].map(([k, v]) => [k, structuredClone(v)]));
  /** @type {string[]} */ const added = [];
  const rank = /** @type {Record<string, number>} */ (SOURCE_RANK)[source] || 0;
  for (const r of rows) {
    const k = keyOf(provider, r.id);
    let e = out.get(k);
    if (!e) { e = { id: r.id, provider, label: r.label, sources: [], context: null, price: null, capabilities: null, evals: {}, first_seen: at, last_seen: at, missed: 0, available: true, from: {} }; out.set(k, e); added.push(k); }
    if (!e.sources.includes(source)) e.sources.push(source);
    e.last_seen = at; e.missed = 0; e.available = true;
    const take = (/** @type {string} */ field, /** @type {any} */ value) => {
      if (value === null || value === undefined) return;
      const had = /** @type {Record<string, number>} */ (SOURCE_RANK)[e.from[field]] || 0;
      if (!had || rank >= had) { e[field] = value; e.from[field] = source; }
    };
    take("label", r.label && r.label !== r.id ? r.label : null);
    take("context", r.context); take("price", r.price); take("capabilities", r.capabilities);
  }
  return { entries: out, added };
}

/**
 * OpenRouter's rows joined onto the entries a provider's own source made, by `joinKey`, for price, context and capabilities the provider's list does not carry. An OpenRouter row that matches
 * no entry is not added under the provider (it is a model that provider does not list for this account); it is its own provider "openrouter" entry when that source is merged on its own.
 * @param {Map<string, any>} entries @param {ReturnType<typeof normalizeApi>} orRows @param {number} at
 */
export function joinOpenRouter(entries, orRows, at) {
  const by = new Map(orRows.map((r) => [joinKey(r.id), r]));
  const out = new Map([...entries].map(([k, v]) => [k, structuredClone(v)]));
  for (const [k, e] of out) {
    if (e.provider === "openrouter") continue;
    const r = by.get(joinKey(e.id));
    if (!r) continue;
    const rank = SOURCE_RANK.openrouter;
    if (!e.sources.includes("openrouter")) e.sources.push("openrouter");
    for (const f of /** @type {const} */ (["context", "price", "capabilities"])) {
      const had = /** @type {Record<string, number>} */ (SOURCE_RANK)[e.from[f]] || 0;
      if (/** @type {any} */ (r)[f] !== null && (!had || rank >= had) && (e[f] === null || e[f] === undefined || had <= rank)) { e[f] = /** @type {any} */ (r)[f]; e.from[f] = "openrouter"; }
    }
    void at;
  }
  return out;
}

/** After a refresh in which these keys were seen, every other entry has missed one more: past MISSED_LIMIT it is marked unavailable. @param {Map<string, any>} entries @param {Set<string>} seen */
export function ageMissing(entries, seen) {
  const out = new Map([...entries].map(([k, v]) => [k, structuredClone(v)]));
  for (const [k, e] of out) if (!seen.has(k)) { e.missed = (e.missed || 0) + 1; if (e.missed >= MISSED_LIMIT) e.available = false; }
  return out;
}

/**
 * The evals a new model could be run through, each with a token budget (an estimate, not a measurement) so its cost follows the model's own price. `usd` is null when the model's price is unknown.
 * @type {{ id: string, label: string, what: string, in: number, out: number, runner: string }[]}
 */
export const EVAL_TYPES = Object.freeze([
  { id: "capsule-answer", label: "Quick answer", what: "does it answer only from its facts, cite them, and say it does not know", in: 40_000, out: 4_000, runner: "scripts/eval-iq-prompt.js --live" },
  { id: "memory-answer", label: "Memory answers", what: "does memory plus this model answer questions about the person's own life, and stay quiet when it does not know", in: 400_000, out: 20_000, runner: "scripts/eval-answer.js --record" },
  { id: "memory-bar", label: "Memory quality bar", what: "the 0.2 memory measures: every one must pass", in: 600_000, out: 30_000, runner: "scripts/eval-bar.js --record" },
  { id: "head-to-head", label: "Head to head", what: "same questions, several ways of giving it memory, scored without a judge model", in: 1_500_000, out: 60_000, runner: "scripts/eval-h2h.js --record" },
  { id: "tool-use", label: "Tool use", what: "ten everyday Vyre tasks through the small tool listing: pass rate, turns and tokens", in: 1_600_000, out: 8_000, runner: "scripts/token-proof.mjs run" },
]);

/** The cost of one eval type for a model, in USD, from its price (per million tokens); null when the price is unknown. @param {{ in: number, out: number }} t @param {{ in: number, out: number } | null} price */
export function evalUsd(t, price) {
  if (!price || !(price.in >= 0) || !(price.out >= 0)) return null;
  return Math.round(((t.in * price.in + t.out * price.out) / 1e6) * 100) / 100;
}

/**
 * The proposal for a new model: each eval type with its cost, and the total. A model with no price still gets the proposal, with the cost said to be unknown.
 * @param {{ id: string, provider: string, label?: string, price: { in: number, out: number } | null }} model
 */
export function proposeEvals(model) {
  const types = EVAL_TYPES.map((t) => ({ id: t.id, label: t.label, what: t.what, usd: evalUsd(t, model.price) }));
  const known = types.every((t) => t.usd !== null);
  return { model: keyOf(model.provider, model.id), label: model.label || model.id, types, total_usd: known ? Math.round(types.reduce((n, t) => n + /** @type {number} */ (t.usd), 0) * 100) / 100 : null, price_known: known };
}
