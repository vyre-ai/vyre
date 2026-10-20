// @ts-check
// lib/model-registry: the pure part of the model registry (R031-84), the one model service every picker reads. Provider /models answers, what a CLI reported, and OpenRouter's public catalogue become one list
// of entries; a new id is noticed; an eval's cost is worked out from the model's own price; and an entry becomes the one shape a picker shows (modelView). No network, no storage, no clock but the one it is given.
//
// An entry: { id, provider, label, vendor, sources: string[], context, max_output, price: { in, out } | null (USD per million tokens), capabilities | null, version, released, accounts: string[], evals,
// first_seen, last_seen, missed, available, from: { <field>: source } }. capabilities: { tools, reasoning, vision, efforts: string[], default_effort }.

/** Rank of what each source knows, highest wins a field: the provider's own answer, then what a CLI reported, then OpenRouter's description of it (and its catalogue of a provider's models), then the fallback list. */
export const SOURCE_RANK = Object.freeze({ api: 4, cli: 3, openrouter: 2, catalogue: 2, fallback: 1 });
/** How many refreshes a model may be missing from every source before it is marked unavailable (it is never deleted: an eval score stays). */
export const MISSED_LIMIT = 3;
/** The providers the registry names, and the OpenRouter vendor prefix each one's models carry. */
export const PROVIDERS = Object.freeze({ claude: "anthropic", codex: "openai", grok: "x-ai", openrouter: "", "openai-compatible": "", opencode: "" });
/**
 * How a sign-in provider's own model id is written, from OpenRouter's id for it (its catalogue lists every provider's models with their details): Anthropic writes "claude-opus-4-8" where OpenRouter
 * writes "anthropic/claude-opus-4.8"; OpenAI and xAI keep the dots. Only the providers whose models OpenRouter re-lists are here.
 * @type {Readonly<Record<string, (s: string) => string>>}
 */
const NATIVE_ID = Object.freeze({ claude: (/** @type {string} */ s) => s.replace(/\./g, "-"), codex: (/** @type {string} */ s) => s, grok: (/** @type {string} */ s) => s });
/** The sign-in providers whose models OpenRouter's catalogue re-lists. */
export const CATALOGUE_PROVIDERS = Object.freeze(Object.keys(NATIVE_ID));
/** The reasoning effort levels a turn can be set to (threads.effort, agents.update take these), lowest first: a model's own levels are the ones of these it supports, in this order. */
export const EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** @param {unknown} v @param {number} [n] */
const text = (v, n = 120) => (typeof v === "string" ? v.trim().slice(0, n) : "");
/** @param {any} v */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** The entry key. @param {string} provider @param {string} id */
export const keyOf = (provider, id) => `${provider}/${id}`;

/** "Anthropic: Claude Opus 4.8" is vendor "Anthropic" and name "Claude Opus 4.8"; a name with no vendor in front is the name. @param {string} name */
export function splitVendor(name) {
  const m = /^([^:]{1,40}):\s+(.+)$/.exec(name);
  return m ? { vendor: m[1].trim(), name: m[2].trim() } : { vendor: "", name };
}

/** A date written in an id or slug ("-20260921", "-2025-08-07"), else from a creation time (ms), as YYYY-MM-DD; null when neither says. @param {string} id @param {number | undefined} created */
export function versionOf(id, created) {
  const m = /-(20\d{2})-?(\d{2})-?(\d{2})(?:$|[^\d])/.exec(String(id || ""));
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  return created && Number.isFinite(created) && created > 0 ? new Date(created).toISOString().slice(0, 10) : null;
}

/** A provider's effort levels, the known words only, lowest first. @param {unknown} list */
export function effortsOf(list) {
  const got = new Set((Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase().trim()));
  return EFFORT_ORDER.filter((e) => got.has(e));
}

/** @param {any} v */
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
/** @param {any} v */
const bool = (v) => (v === true ? true : v === false ? false : null);

/**
 * One provider's /models answer as plain rows, with every detail it gives:
 *   Anthropic: { data: [{ id, display_name, created_at, max_input_tokens, max_tokens, capabilities: { image_input: { supported }, thinking: { supported }, effort: { <level>: { supported } } } }] }.
 *   OpenAI and xAI: { data: [{ id, created }] } (xAI's language-models list also gives input_modalities; an OpenAI-compatible server may give context_length or max_model_len). A price comes from OpenRouter's catalogue, joined by id.
 *   OpenRouter: { data: [{ id, name ("Vendor: Name"), canonical_slug, created, context_length, top_provider: { max_completion_tokens }, pricing: { prompt, completion } (USD per token, as strings),
 *     supported_parameters, architecture: { input_modalities }, reasoning: { supported_efforts, default_effort } }] }.
 * Anything else is no rows.
 * @param {string} provider @param {any} body
 * @returns {{ id: string, label: string, vendor?: string, context: number | null, max_output?: number | null, price: { in: number, out: number } | null, capabilities: any, created?: number, version?: string | null }[]}
 */
export function normalizeApi(provider, body) {
  const rows = isObj(body) && Array.isArray(body.data) ? body.data : isObj(body) && Array.isArray(body.models) ? body.models : [];
  /** @type {ReturnType<typeof normalizeApi>} */ const out = [];
  for (const r of rows.slice(0, 2000)) {
    if (!isObj(r) || typeof r.id !== "string" || !r.id) continue;
    const id = r.id.slice(0, 120);
    const named = splitVendor(text(r.display_name) || text(r.name) || id);
    const created = typeof r.created === "number" ? r.created * 1000 : typeof r.created_at === "string" && Date.parse(r.created_at) ? Date.parse(r.created_at) : undefined;
    const version = versionOf(text(r.canonical_slug, 160) || id, created);
    const base = { id, label: named.name || id, ...(named.vendor ? { vendor: named.vendor } : {}), ...(created ? { created } : {}), version };
    if (provider === "openrouter") {
      const per = (/** @type {any} */ x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null; };
      const pin = per(r.pricing && r.pricing.prompt), pout = per(r.pricing && r.pricing.completion);
      const params = Array.isArray(r.supported_parameters) ? r.supported_parameters.map(String) : [];
      const mods = isObj(r.architecture) && Array.isArray(r.architecture.input_modalities) ? r.architecture.input_modalities.map(String) : [];
      const reason = isObj(r.reasoning) ? r.reasoning : {};
      const efforts = effortsOf(reason.supported_efforts);
      out.push({ ...base, context: count(r.context_length), max_output: count(isObj(r.top_provider) ? r.top_provider.max_completion_tokens : null), price: pin !== null && pout !== null ? { in: pin, out: pout } : null,
        capabilities: { tools: params.includes("tools"), reasoning: params.includes("reasoning") || params.includes("include_reasoning"), vision: mods.includes("image"), efforts, default_effort: efforts.includes(String(reason.default_effort)) ? String(reason.default_effort) : null } });
      continue;
    }
    // Anthropic's own list says what each model can do; others say less, and what they do not say stays unknown (null), never guessed.
    const caps = isObj(r.capabilities) ? r.capabilities : null;
    const leaf = (/** @type {any} */ x) => (isObj(x) ? bool(x.supported) : bool(x));
    const effortCaps = caps && isObj(caps.effort) ? caps.effort : null;
    const efforts = effortCaps ? EFFORT_ORDER.filter((e) => leaf(effortCaps[e]) === true) : [];
    const mods = Array.isArray(r.input_modalities) ? r.input_modalities.map(String) : null;
    const capabilities = caps ? { tools: null, reasoning: caps.thinking ? leaf(caps.thinking) : null, vision: caps.image_input ? leaf(caps.image_input) : null, efforts, default_effort: null }
      : mods ? { tools: null, reasoning: null, vision: mods.includes("image"), efforts: [], default_effort: null } : null;
    out.push({ ...base, context: count(r.max_input_tokens ?? r.context_length ?? r.context_window ?? r.max_model_len), max_output: count(r.max_tokens ?? r.max_output_tokens ?? r.max_completion_tokens),
      price: null, capabilities });
  }
  return out;
}

/**
 * A sign-in provider's models from OpenRouter's catalogue (its public list re-lists Anthropic's, OpenAI's and xAI's own models with context, price, modalities and effort levels): the rows under the
 * provider's vendor prefix, each under the provider's own id. A variant (":batch", ":free") or an alias ("~...") is not a model of the provider's own.
 * @param {string} provider @param {ReturnType<typeof normalizeApi>} orRows
 */
export function catalogueRows(provider, orRows) {
  const vendor = /** @type {Record<string, string>} */ (PROVIDERS)[provider], native = NATIVE_ID[provider];
  if (!vendor || !native) return [];
  /** @type {ReturnType<typeof normalizeApi>} */ const out = [];
  for (const r of orRows) {
    if (!r.id.startsWith(`${vendor}/`) || /[:~]/.test(r.id)) continue;
    const id = native(r.id.slice(vendor.length + 1));
    if (!/^[a-z][a-z0-9.-]{0,118}$/.test(id)) continue;
    out.push({ ...r, id });
  }
  return out;
}

/** The key two ids of the same model share: lower case, the vendor prefix off, a date suffix off, dots and dashes the same ("claude-sonnet-4.5" and "claude-sonnet-4-5-20250929"). @param {string} id */
export function joinKey(id) {
  return String(id).toLowerCase().replace(/^[a-z0-9-]+\//, "").replace(/-(?:20\d{6}|\d{4}-\d{2}-\d{2})$/, "").replace(/-latest$/, "").replace(/[.:_]/g, "-").replace(/-+/g, "-");
}

/**
 * What each source knows of what a model can do, combined capability by capability: a source's word on one (vision, tools, reasoning, its effort levels) stands unless a higher-ranked source said
 * otherwise; what nobody said stays null. `from` keeps the source of each capability.
 * @param {any} had the entry's capabilities @param {any} add the source's @param {Record<string, string>} from @param {string} source
 */
function mergeCaps(had, add, from, source) {
  if (!isObj(add)) return had;
  const out = { tools: null, reasoning: null, vision: null, efforts: [], default_effort: null, ...(isObj(had) ? had : {}) };
  const rank = /** @type {Record<string, number>} */ (SOURCE_RANK)[source] || 0;
  for (const k of ["tools", "reasoning", "vision", "efforts", "default_effort"]) {
    const v = add[k];
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    const was = /** @type {Record<string, number>} */ (SOURCE_RANK)[from[`cap.${k}`]] || 0;
    if (!was || rank >= was || out[k] === null || (Array.isArray(out[k]) && !out[k].length)) { out[k] = Array.isArray(v) ? [...v] : v; from[`cap.${k}`] = source; }
  }
  return out;
}

/** The fields a source may set on an entry, besides its capabilities. */
const FIELDS = /** @type {const} */ (["label", "vendor", "context", "max_output", "price", "version", "created"]);

/**
 * Merge one source's rows into the entries, field by field, the higher-ranked source winning each field it knows. Returns the new entries (a Map by key) and the keys that were not there before.
 * `account` is the AI account whose own list this is (a key's /models): the entry remembers it, so a picker lists for each account only what that account can run.
 * @param {Map<string, any>} entries @param {string} provider @param {string} source @param {ReturnType<typeof normalizeApi>} rows @param {number} at @param {string} [account]
 * @returns {{ entries: Map<string, any>, added: string[] }}
 */
export function mergeSource(entries, provider, source, rows, at, account) {
  const out = new Map([...entries].map(([k, v]) => [k, structuredClone(v)]));
  /** @type {string[]} */ const added = [];
  const rank = /** @type {Record<string, number>} */ (SOURCE_RANK)[source] || 0;
  for (const r of rows) {
    const k = keyOf(provider, r.id);
    let e = out.get(k);
    if (!e) { e = { id: r.id, provider, label: r.label, sources: [], context: null, price: null, capabilities: null, evals: {}, first_seen: at, last_seen: at, missed: 0, available: true, from: {} }; out.set(k, e); added.push(k); }
    if (!e.sources.includes(source)) e.sources.push(source);
    if (account) e.accounts = [...new Set([...(Array.isArray(e.accounts) ? e.accounts : []), String(account)])].slice(-50);
    e.last_seen = at; e.missed = 0; e.available = true;
    const take = (/** @type {string} */ field, /** @type {any} */ value) => {
      if (value === null || value === undefined || value === "") return;
      const had = /** @type {Record<string, number>} */ (SOURCE_RANK)[e.from[field]] || 0;
      if (!had || rank >= had) { e[field] = value; e.from[field] = source; }
    };
    for (const f of FIELDS) take(f, f === "label" ? (r.label && r.label !== r.id ? r.label : null) : /** @type {any} */ (r)[f]);
    if (r.capabilities) { e.capabilities = mergeCaps(e.capabilities, r.capabilities, e.from, source); e.from.capabilities = e.from.capabilities && (/** @type {Record<string, number>} */ (SOURCE_RANK)[e.from.capabilities] || 0) > rank ? e.from.capabilities : source; }
  }
  return { entries: out, added };
}

/**
 * OpenRouter's rows joined onto the entries a provider's own source made, by `joinKey`, for what the provider's list does not carry: context, max output, price, version, the vendor and the
 * capabilities (vision, tools, reasoning and the effort levels). A label a provider gave stands. An OpenRouter row that matches no entry is not added under the provider (it is a model that provider
 * does not list for this account); it is its own provider "openrouter" entry when that source is merged on its own.
 * @param {Map<string, any>} entries @param {ReturnType<typeof normalizeApi>} orRows @param {number} at
 */
export function joinOpenRouter(entries, orRows, at) {
  const by = new Map(orRows.map((r) => [joinKey(r.id), r]));
  const out = new Map([...entries].map(([k, v]) => [k, structuredClone(v)]));
  const rank = SOURCE_RANK.openrouter;
  for (const [, e] of out) {
    if (e.provider === "openrouter" || e.provider === "opencode") continue;
    const r = by.get(joinKey(e.id));
    if (!r) continue;
    if (!e.sources.includes("openrouter")) e.sources.push("openrouter");
    for (const f of /** @type {const} */ (["context", "max_output", "price", "version", "vendor", "label"])) {
      const v = /** @type {any} */ (r)[f];
      if (v === null || v === undefined || v === "") continue;
      const had = /** @type {Record<string, number>} */ (SOURCE_RANK)[e.from[f]] || 0;
      if (f === "label" && (had || (e.label && e.label !== e.id))) continue;
      if (!had || rank >= had || e[f] === null || e[f] === undefined) { e[f] = v; e.from[f] = "openrouter"; }
    }
    if (r.capabilities) { e.capabilities = mergeCaps(e.capabilities, r.capabilities, e.from, "openrouter"); if (!e.from.capabilities) e.from.capabilities = "openrouter"; }
    void at;
  }
  return out;
}

/** The company behind each provider's models, when the registry has not been told (an entry from a CLI or a key's list carries none). */
const VENDOR = Object.freeze({ claude: "Anthropic", codex: "OpenAI", grok: "xAI", opencode: "OpenCode" });

/**
 * The one shape every picker shows (sessions.accounts.models, sessions.models, providers.list): the model's real name as its provider gives it, its provider and vendor, its version (a date), context
 * window and most output in tokens, price per million tokens in and out, what it can do (vision, tools, reasoning) and the effort levels it takes, lowest first. Unknown is null, never a guess.
 * @param {any} e an entry @param {string[]} [accounts] the AI accounts of the viewing person that give it
 */
export function modelView(e, accounts = []) {
  const caps = isObj(e.capabilities) ? e.capabilities : {};
  const efforts = effortsOf(caps.efforts);
  return {
    id: String(e.id), key: keyOf(e.provider, e.id), label: String(e.label || e.id), name: String(e.label || e.id), provider: String(e.provider),
    vendor: e.vendor ? String(e.vendor) : /** @type {Record<string, string>} */ (VENDOR)[e.provider] || null,
    version: e.version || versionOf(e.id, e.created) || null, context: count(e.context), max_output: count(e.max_output), price: e.price && Number.isFinite(e.price.in) && Number.isFinite(e.price.out) ? { in: e.price.in, out: e.price.out } : null,
    vision: bool(caps.vision), tools: bool(caps.tools), reasoning: bool(caps.reasoning), efforts, default_effort: efforts.includes(caps.default_effort) ? caps.default_effort : null,
    accounts: [...accounts],
  };
}

/**
 * The models one AI account can run, from the registry's entries of its provider: a key's own list when the registry read one for this account (each entry remembers the accounts that listed it); a
 * sign-in's, what its CLI reported when it has, else the provider's catalogue; an OpenRouter key, OpenRouter's catalogue. An OpenAI-compatible server lists its own or nothing.
 * @param {{ id: string, provider: string, kind?: string }} account @param {any[]} entries the provider's available entries
 */
export function entriesForAccount(account, entries) {
  const mine = entries.filter((e) => e.provider === account.provider);
  const listed = mine.filter((e) => Array.isArray(e.accounts) && e.accounts.includes(account.id));
  if (listed.length) return listed;
  if (account.provider === "openai-compatible" || account.provider === "opencode") return [];
  const cli = mine.filter((e) => Array.isArray(e.sources) && e.sources.includes("cli"));
  if (account.kind !== "api-key" && cli.length) return cli;
  return mine.filter((e) => Array.isArray(e.sources) && (e.sources.includes("catalogue") || e.sources.includes("openrouter") || e.sources.includes("api") || e.sources.includes("cli")));
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
