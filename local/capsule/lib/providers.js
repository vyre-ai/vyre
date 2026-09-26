// @ts-check
// providers: what running modules put in the Capsule, read from their manifests' `shows.capsule`.
//
// A module names two kinds of thing there (SPEC section 5.1, and the vault's contract in
// ADR 0006):
//
//   "results:<tool>"          a search provider: { q, limit } -> { rows: [{ id, name, kind, sub }] }
//   "action:<tool>[#suffix]"  a verb on that module's results, called with { ...input, id, front }
//
// Each value is { title, input? }. The suffix after # only keeps a key unique, so one tool can
// back several actions ("copy username", "copy one-time code") that differ by `input`. Object
// order is list order, and Enter runs the first action. A plain array of keys is allowed too;
// then nothing has a title and one is made from the module or tool name.
//
// Nothing here runs unless called: refresh() reads the listing, search() asks the providers,
// run() calls one action. A query is sent to the providers and nowhere else: never logged,
// never emitted, never kept.

import { match } from "./local.js";

/** How long an action may take: it may wait on Touch ID inside the tool. */
export const ACTION_TIMEOUT_MS = 45_000;
/** A search is typed, so shorter queries are not sent to any provider. */
export const MIN_QUERY = 2;

/** @typedef {{ tool: string, title: string, input: Record<string, any> }} Provider */
/** @typedef {{ key: string, tool: string, title: string, input: Record<string, any> }} Action */
/** @typedef {{ module: string, results: Provider[], actions: Action[] }} ModuleShows */
/** @typedef {{ kind: "module", id: string, label: string, sub: string, module: string, provider: string,
 *   rowId: string, rowKind: string, target: string, score: number }} ModuleResult */

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const titleCase = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/**
 * One module's `shows.capsule`, in either shape, as ordered providers and actions.
 * Unknown keys are skipped, so a later kind of entry does not break an older Capsule.
 * @param {string} module @param {any} capsule
 * @returns {ModuleShows}
 */
export function parseShows(module, capsule) {
  /** @type {[string, any][]} */
  const entries = Array.isArray(capsule) ? capsule.filter(k => typeof k === "string").map(k => [k, {}])
    : isObj(capsule) ? Object.entries(capsule) : [];
  /** @type {ModuleShows} */
  const out = { module, results: [], actions: [] };
  const seen = new Set();
  for (const [key, raw] of entries) {
    if (seen.has(key)) continue;
    seen.add(key);
    const v = isObj(raw) ? raw : {};
    const input = isObj(v.input) ? v.input : {};
    const given = typeof v.title === "string" && v.title.trim() ? v.title.trim() : "";
    let m;
    if ((m = /^results:([^#\s]+)$/.exec(key))) {
      out.results.push({ tool: m[1], title: given || titleCase(module), input });
    } else if ((m = /^action:([^#\s]+)(?:#.*)?$/.exec(key))) {
      out.actions.push({ key, tool: m[1], title: given || m[1], input });
    }
  }
  return out;
}

/** The capsule's section of a module row, wherever the listing puts the manifest. */
function capsuleOf(row) {
  const shows = (row && (row.shows || (row.manifest && row.manifest.shows))) || null;
  return shows ? shows.capsule : undefined;
}

/** A promise that settles within `ms`, as `fallback` if it had not by then. */
function within(p, ms, fallback) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise(r => { timer = setTimeout(() => r(fallback), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** The words of a query that could name a site: "github", "mail.google.com". */
const siteWords = q => String(q).toLowerCase().split(/\s+/).filter(w => w.length >= 2);

/** The host part of a vault row's sub ("login · github.com"), or "". */
function hostOf(sub) {
  const s = String(sub || "");
  const i = s.lastIndexOf("·");
  const h = (i >= 0 ? s.slice(i + 1) : s).trim().toLowerCase();
  return /\./.test(h) && !/\s/.test(h) ? h : "";
}

/**
 * How much a launcher user wants this module row for `q`: the name's match, never below 0.5
 * (the provider matched it on something, a host or a description), and a small bump when the
 * vault's row lives on a site the query names, so "github" puts the GitHub login first.
 * @param {string} module @param {string} q @param {{ name: string, sub?: string }} row
 */
export function scoreRow(module, q, row) {
  let s = Math.max(0.5, match(q, row.name));
  if (module === "vault") {
    const host = hostOf(row.sub);
    if (host && siteWords(q).some(w => host.includes(w))) s += 0.1;
  }
  return s;
}

export class Providers {
  /** @param {{ client: { call: (tool: string, input?: any, opts?: any) => Promise<any>, get: (route: string, opts?: any) => Promise<any> } }} deps */
  constructor({ client }) {
    this.client = client;
    /** @type {ModuleShows[]} */
    this.modules = [];
  }

  /**
   * Read GET /v1/modules and keep what each running module shows in the Capsule. When
   * GET /v1/tools answers (it lists only the tools this caller may use), anything naming a tool
   * not on it is dropped. A failed listing keeps what was known before.
   * @returns {Promise<{ ok: true, modules: number } | { ok: false, error: string }>}
   */
  async refresh() {
    const [mods, tools] = await Promise.all([this.client.get("/v1/modules"), this.client.get("/v1/tools")]);
    if (!mods || mods.error || !Array.isArray(mods.data)) return { ok: false, error: (mods && mods.error && mods.error.message) || "no module listing" };
    /** @type {Set<string> | null} */
    const callable = tools && Array.isArray(tools.data) ? new Set(tools.data.map(t => (typeof t === "string" ? t : t && t.name))) : null;
    const ok = t => !callable || callable.has(t);
    /** @type {ModuleShows[]} */
    const next = [];
    for (const row of mods.data) {
      if (!row || typeof row.name !== "string") continue;
      if (row.state !== undefined && row.state !== "running") continue;
      const cap = capsuleOf(row);
      if (cap === undefined) continue;
      const s = parseShows(row.name, cap);
      s.results = s.results.filter(p => ok(p.tool));
      s.actions = s.actions.filter(a => ok(a.tool));
      if (s.results.length || s.actions.length) next.push(s);
    }
    this.modules = next;
    return { ok: true, modules: next.length };
  }

  /** What each module shows, in listing order. A copy: changing it changes nothing here. */
  list() {
    return this.modules.map(m => ({ module: m.module, results: m.results.map(p => ({ ...p, input: { ...p.input } })),
      actions: m.actions.map(a => ({ ...a, input: { ...a.input } })) }));
  }

  /**
   * Ask every search provider at once, each with its own timeout. A provider that is slow, errs
   * or answers nonsense adds nothing and hides no one else. Queries shorter than two characters
   * go nowhere.
   * @param {string} q @param {{ limit?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<ModuleResult[]>}
   */
  async search(q, { limit = 5, timeoutMs = 600 } = {}) {
    const query = String(q ?? "").trim();
    if (query.length < MIN_QUERY) return [];
    const asks = [];
    for (const m of this.modules) {
      for (const p of m.results) {
        const call = this.client.call(p.tool, { ...p.input, q: query, limit }, { timeout: timeoutMs });
        asks.push(within(call, timeoutMs, null).then(ans => this.#rows(m.module, p, query, ans, limit)));
      }
    }
    return (await Promise.all(asks)).flat();
  }

  /** @returns {ModuleResult[]} */
  #rows(module, p, q, ans, limit) {
    if (!ans || ans.error) return [];
    const d = ans.data;
    const rows = Array.isArray(d) ? d : d && Array.isArray(d.rows) ? d.rows : [];
    /** @type {ModuleResult[]} */
    const out = [];
    for (const r of rows) {
      if (!r || (typeof r.id !== "string" && typeof r.id !== "number")) continue;
      const name = typeof r.name === "string" && r.name ? r.name : String(r.id);
      out.push({
        kind: "module", id: `${module}:${r.id}`, label: name,
        sub: typeof r.sub === "string" && r.sub ? r.sub : p.title,
        module, provider: p.title, rowId: String(r.id), rowKind: typeof r.kind === "string" ? r.kind : "",
        target: "", score: scoreRow(module, q, { name, sub: r.sub }),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * The verbs for one of this module's results, in the manifest's order. The first is Enter's.
   * @param {{ module?: string } | null | undefined} result
   * @returns {{ key: string, title: string }[]}
   */
  actions(result) {
    const m = result && this.modules.find(x => x.module === result.module);
    return m ? m.actions.map(a => ({ key: a.key, title: a.title })) : [];
  }

  /**
   * Run one action on a result: the tool gets { ...input, id, front }. `said` is shown as is,
   * and so is an error (`reason` is its code, when it has one). Allow for Touch ID: the answer can take many seconds.
   * @param {{ module: string, rowId: string }} result @param {string} key
   * @param {{ bundle?: string, pid?: number } | null} [front] the app in front when the Capsule opened
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ said?: string, code?: string, period?: number, remaining?: number, data: any } | { error: string, reason?: string }>}
   */
  async run(result, key, front, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
    const m = result && this.modules.find(x => x.module === result.module);
    const a = m && m.actions.find(x => x.key === key);
    if (!a) return { error: "That action is no longer offered." };
    const app = front && typeof front.bundle === "string" && Number.isInteger(front.pid) ? { bundle: front.bundle, pid: front.pid } : undefined;
    const input = { ...a.input, id: result.rowId, ...(app ? { front: app } : {}) };
    const late = { error: { code: "timeout", message: "No answer in time. Try again." } };
    const ans = await within(this.client.call(a.tool, input, { timeout: timeoutMs }), timeoutMs + Math.min(1000, Math.ceil(timeoutMs / 10)), late);
    if (!ans || ans.error) {
      const e = (ans && ans.error) || {};
      const message = typeof e === "string" ? e : e.message || e.code || "It did not work.";
      return typeof e === "object" && e.code ? { error: message, reason: e.code } : { error: message };
    }
    const d = ans.data;
    /** @type {any} */
    const out = { data: d };
    if (isObj(d)) {
      if (typeof d.said === "string") out.said = d.said;
      if (typeof d.code === "string") out.code = d.code;
      if (typeof d.period === "number") out.period = d.period;
      if (typeof d.remaining === "number") out.remaining = d.remaining;
    }
    return out;
  }
}
