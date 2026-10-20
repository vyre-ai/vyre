// @ts-check
// The one model picker's pure half: every screen that chooses a model (an agent's AI tab, the chat switcher, welcome's model step, Settings, a Flow's AI step) reads the person's own AI accounts and the
// models each can run from the one model service (sessions.accounts.list, then sessions.accounts.models: lib/model-registry.js modelView), and draws them with these. No model name lives here; a model's
// name is the one its provider gives. Pure: no React, no box calls; src/models/useMyModels.ts reads the box and ui/components/ModelPicker.tsx draws.

/**
 * @typedef {{ id: string, key: string, name: string, label?: string, provider: string, vendor: string | null, version: string | null, context: number | null, max_output: number | null,
 *   price: { in: number, out: number } | null, vision: boolean | null, tools: boolean | null, reasoning: boolean | null, efforts: string[], default_effort: string | null, accounts?: string[] }} Model
 * @typedef {{ id: string, label: string, provider: string, kind: string }} Account
 * @typedef {{ account: Account, models: Model[] }} ModelGroup
 */

/** The effort words a person reads, by level. */
const EFFORT_WORDS = /** @type {Record<string, string>} */ ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });

/** An account a model can run on now: signed in, not waiting on its owner, not the machine's stand-in login. @param {any} a */
export const usable = (a) => Boolean(a && typeof a.id === "string" && !a.pending && !a.synthetic && (a.kind !== "login" || a.signed_in_at != null || a.signed_in === true));

/** sessions.accounts.list's answer as the accounts a picker groups by. @param {unknown} data @returns {Account[]} */
export function accountsOf(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(/** @type {any} */ (data)?.accounts) ? /** @type {any} */ (data).accounts : [];
  return rows.filter(usable).map((/** @type {any} */ a) => ({ id: String(a.id), label: String(a.label || a.provider), provider: String(a.provider || ""), kind: String(a.kind || "") }));
}

/** A model from the service's answer, checked: a row without an id is dropped, a missing detail is null. @param {any} m @param {string} provider @returns {Model | null} */
export function modelOf(m, provider) {
  if (!m || typeof m.id !== "string" || !m.id) return null;
  const n = (/** @type {any} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const b = (/** @type {any} */ v) => (v === true ? true : v === false ? false : null);
  const p = String(m.provider || provider);
  return {
    id: m.id, key: String(m.key || `${p}/${m.id}`), name: String(m.name || m.label || m.id), provider: p, vendor: typeof m.vendor === "string" && m.vendor ? m.vendor : null,
    version: typeof m.version === "string" && m.version ? m.version : null, context: n(m.context), max_output: n(m.max_output),
    price: m.price && Number.isFinite(m.price.in) && Number.isFinite(m.price.out) ? { in: m.price.in, out: m.price.out } : null,
    vision: b(m.vision), tools: b(m.tools), reasoning: b(m.reasoning), efforts: Array.isArray(m.efforts) ? m.efforts.filter((/** @type {any} */ e) => typeof e === "string" && EFFORT_WORDS[e]) : [],
    default_effort: typeof m.default_effort === "string" && EFFORT_WORDS[m.default_effort] ? m.default_effort : null,
  };
}

/**
 * The picker's groups: one per account, in the order the person's accounts come, each with the models it can run (sessions.accounts.models' answer for it). An account whose list failed has none.
 * @param {Account[]} accounts @param {(any | null)[]} answers sessions.accounts.models' answer for each account, in the same order @returns {ModelGroup[]}
 */
export function groupsOf(accounts, answers) {
  return accounts.map((a, i) => {
    const r = answers[i];
    const list = Array.isArray(r?.models) ? r.models : Array.isArray(r) ? r : [];
    /** @type {Model[]} */ const models = [];
    for (const m of list) { const v = modelOf(m, a.provider); if (v) models.push(v); }
    return { account: a, models };
  });
}

/** 1000000 is "1M", 200000 "200K", 1050000 "1.05M". @param {number | null} n */
export function tokensWord(n) {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 100) / 100}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** $4, $0.10, $1.25: a price per million tokens. @param {number} usd */
const dollars = (usd) => `$${usd >= 1 || usd === 0 ? String(Math.round(usd * 100) / 100) : (Math.round(usd * 100) / 100).toFixed(2)}`;

/** The price, said once: "$4 in, $20 out per million tokens", or "" when the provider does not say. @param {Model} m */
export function priceWords(m) {
  return m.price ? `${dollars(m.price.in)} in, ${dollars(m.price.out)} out per million tokens` : "";
}

/**
 * One compact line of a model's details for a picker row: who makes it, its context, its price, and a mark for vision and tools, each only when the provider says.
 * "Anthropic · 1M context · $4 / $20 · vision · tools".
 * @param {Model} m
 */
export function detailLine(m) {
  return [m.vendor || "", m.context ? `${tokensWord(m.context)} context` : "", m.price ? `${dollars(m.price.in)} / ${dollars(m.price.out)}` : "", m.vision ? "vision" : "", m.tools ? "tools" : ""].filter(Boolean).join(" · ");
}

/** Every detail, one line each, for the chosen model under the picker: version, context and output, price, what it can do. @param {Model} m @returns {string[]} */
export function detailRows(m) {
  const can = [m.vision ? "images" : "", m.tools ? "tools" : "", m.reasoning ? "reasoning" : ""].filter(Boolean);
  return [
    m.version ? `Version ${m.version}` : "",
    [m.context ? `Reads ${tokensWord(m.context)} tokens` : "", m.max_output ? `writes up to ${tokensWord(m.max_output)}` : ""].filter(Boolean).join(", "),
    priceWords(m),
    can.length ? `Works with ${can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can[can.length - 1]}` : can[0]}` : "",
  ].filter(Boolean);
}

/** The value a picker keeps for a model on one account: `<account>|<provider>/<model id>`. @param {Account} a @param {Model} m */
export const pickValue = (a, m) => `${a.id}|${m.key}`;

/** What a value names: the account, the provider and the model id. @param {string} v */
export function parsePick(v) {
  const s = String(v || ""), bar = s.indexOf("|"), key = bar >= 0 ? s.slice(bar + 1) : s, slash = key.indexOf("/");
  return { account: bar >= 0 ? s.slice(0, bar) : "", provider: slash >= 0 ? key.slice(0, slash) : "", model: slash >= 0 ? key.slice(slash + 1) : key };
}

/**
 * The row that is chosen now: the exact account and model when the value names an account, else the first account that gives this model (a saved choice names the provider and model only).
 * @param {ModelGroup[]} groups @param {{ account?: string | null, provider?: string | null, model?: string | null }} cur @returns {{ account: Account, model: Model } | null}
 */
export function chosen(groups, cur) {
  if (!cur || !cur.model) return null;
  const same = (/** @type {Model} */ m) => m.id === cur.model && (!cur.provider || m.provider === cur.provider);
  for (const g of groups) if (cur.account && g.account.id === cur.account) { const m = g.models.find(same); if (m) return { account: g.account, model: m }; }
  for (const g of groups) { const m = g.models.find(same); if (m) return { account: g.account, model: m }; }
  return null;
}

/** The groups narrowed by what the person typed: a model's name, id, vendor or the account's name; an empty search is everything. Groups keep their order and drop when empty. @param {ModelGroup[]} groups @param {string} query */
export function searchModels(groups, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return groups;
  return groups.map((g) => ({ account: g.account, models: g.account.label.toLowerCase().includes(q) ? g.models : g.models.filter((m) => [m.name, m.id, m.vendor || ""].some((s) => s.toLowerCase().includes(q))) })).filter((g) => g.models.length);
}

/** The effort control's choices for a model: its own levels, lowest first, with their words; none when the model takes no effort. @param {Model | null | undefined} m @returns {[string, string][]} */
export function effortChoices(m) {
  return m && m.efforts.length ? m.efforts.map((e) => /** @type {[string, string]} */ ([e, EFFORT_WORDS[e]])) : [];
}

/** The effort to show for a model: the one kept when the model takes it, else the model's own default, else its middle level; "" when it takes none. @param {Model | null | undefined} m @param {string | null | undefined} kept */
export function effortFor(m, kept) {
  if (!m || !m.efforts.length) return "";
  if (kept && m.efforts.includes(kept)) return kept;
  return m.default_effort || m.efforts[Math.floor((m.efforts.length - 1) / 2)];
}

/** A model's real name from the person's picker, by its id (and provider when known); the id itself when no account of theirs gives it. @param {ModelGroup[] | null | undefined} groups @param {string | null | undefined} id @param {string | null} [provider] */
export function nameOf(groups, id, provider = null) {
  if (!id) return "";
  for (const g of groups || []) { const m = g.models.find((x) => x.id === id && (!provider || x.provider === provider)); if (m) return m.name; }
  return id;
}

/** What the picker says when the person has nothing to pick from. @param {ModelGroup[]} groups */
export function emptyWords(groups) {
  if (!groups.length) return "Connect your own AI account in Settings, AI accounts.";
  return "Your AI accounts list no models yet. They show as soon as each provider answers.";
}
