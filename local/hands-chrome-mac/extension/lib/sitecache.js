// @ts-check
// sitecache: what Vyre Computer knows about the sites it works on, kept on this device and never waited for (team/0.2/chrome-learning-plan.md).
//
//   arrive(url)   the card for a page's origin, from memory, else from chrome.storage.local; nothing on a first visit. A miss asks the server once a minute.
//   learn(...)    an op that finished teaches something (observe.js); it is queued per origin.
//   flush()       every 10 s and at run end, each origin's queue is cleaned through the store's allowlist HERE first (a secret-shaped field means the
//                 observation is dropped and never leaves the browser), then sent as one {event:"site.put"}.
//   setCard(...)  the server answers a want with the card; it is kept for the next arrival.
//
// Labels: a control's label goes on the wire only when this device has seen the same text on two separate visits (the 30-minute windows a person's
// use of a site falls in); a label seen once is remembered here and never sent.

import { sanitize, arrivalCard, canonTemplate } from "../shared/sk/site-knowledge.js";
import { observeOp, observeMiss, originOf } from "./observe.js";

export const FLUSH_MS = 10_000;
export const STALE_MS = 10 * 60_000;
export const WANT_EVERY_MS = 60_000;
const DEFAULT_VISIT_MS = 30 * 60_000;
const MAX_LABELS = 400;

/**
 * @param {{ chrome?: any, emit?: (evt: any) => void, now?: () => number, setT?: any, clearT?: any }} [o]
 */
export function createSiteCache({ chrome, emit = () => {}, now = Date.now, setT = setTimeout, clearT = clearTimeout } = {}) {
  /** @type {Map<string, { card: any, rev: number, at: number }>} */ const cards = new Map();
  /** @type {Map<string, Record<string, any>>} */ const pending = new Map();
  /** @type {Map<string, number>} */ const asked = new Map();
  /** Misses of facts the device knows, waiting to be reported: one per origin and item. @type {Map<string, { origin: string, part: string, id: string }>} */ const reports = new Map();
  /** label text by origin and key: the visits that saw it. @type {Map<string, Map<string, { text: string, visits: Set<string> }>>} */ const labels = new Map();
  /** Which rung of the ladder worked on a page template, waiting to be reported; and when each was last sent (the store counts, and throttles, on its own clock). @type {Map<string, { origin: string, template: string, rung: number, lowerFailed: boolean }>} */ const rungPending = new Map();
  /** @type {Map<string, number>} */ const rungSent = new Map();
  /** @type {any} */ let timer = null;
  /** @type {any} */ let this_ = null;
  /** Off until the server says learning is on (site.config): nothing is read from storage, asked, queued, sent or written. */
  let enabled = false;
  const stats = { learned: 0, sent: 0, refused: 0, dropped: 0 };
  let visitMs = DEFAULT_VISIT_MS;
  const visit = () => `v${Math.floor(now() / visitMs)}`;
  const store = chrome && chrome.storage && chrome.storage.local;
  const weak = (/** @type {any} */ h) => { try { if (h && typeof h.unref === "function") h.unref(); } catch { /* not node */ } return h; };

  /** The two-visit evidence for one label. @param {string} origin @param {string} key @param {string} text @returns {string[]} */
  function nameVisits(origin, key, text) {
    let m = labels.get(origin); if (!m) { m = new Map(); labels.set(origin, m); }
    let e = m.get(key);
    if (!e || e.text !== text) { e = { text, visits: new Set() }; m.set(key, e); }
    e.visits.add(visit());
    while (m.size > MAX_LABELS) m.delete(/** @type {string} */ (m.keys().next().value));
    return e.visits.size >= 2 ? [...e.visits].slice(0, 4) : [];
  }

  /** The same two-visit evidence for a set of option names (a menu's choices). @param {string} origin @param {string} key @param {string[]} options @returns {string[]} */
  function choicesVisits(origin, key, options) { return nameVisits(origin, `choices|${key}`, [...options].sort().join("\u0001")); }

  /** Read a card from the device: memory, else storage. @param {string} origin */
  async function load(origin) {
    const have = cards.get(origin);
    if (have) return have;
    if (!store) return null;
    try {
      const r = await store.get(`site:${origin}`);
      const v = r && r[`site:${origin}`];
      if (v && v.card) { cards.set(origin, v); return v; }
    } catch { /* no storage */ }
    return null;
  }

  const api = {
    /** The card for this page's site, at once, and a quiet request to the server when there is none or it is old. @param {string} url */
    async arrive(url) {
      const origin = originOf(url);
      if (!origin || !enabled) return null;
      const have = await load(origin);
      const t = now();
      if ((!have || t - have.at > STALE_MS) && t - (asked.get(origin) || 0) > WANT_EVERY_MS) { asked.set(origin, t); emit({ event: "site.want", origin, ...(have ? { since_rev: have.rev } : {}) }); }
      return have ? have.card : null;
    },
    /** What the server sent. @param {string} origin @param {any} card @param {number} rev */
    async setCard(origin, card, rev) {
      if (!enabled || !originOf(origin) || !card || typeof card !== "object") return;
      const v = { card, rev: Number(rev) || 0, at: now() };
      cards.set(origin, v);
      if (store) { try { await store.set({ [`site:${origin}`]: v }); } catch { /* storage full or gone */ } }
    },
    /** @param {string} origin */
    card(origin) { const c = cards.get(origin); return c ? c.card : null; },
    /** An op finished: queue what it taught. @param {{ op: string, args?: any, result?: any, tabUrl?: string }} o */
    learn(o) {
      if (!enabled) return;
      let got;
      try { got = observeOp({ ...o, nameVisits }); } catch { return; }
      if (!got) return;
      stats.learned++;
      const cur = pending.get(got.origin) || { key: got.origin };
      for (const [k, v] of Object.entries(got.patch)) {
        if (Array.isArray(v)) {
          const by = new Map((Array.isArray(cur[k]) ? cur[k] : []).map((/** @type {any} */ x) => [x.id ?? JSON.stringify(x), x]));
          for (const x of v) by.set(x.id ?? JSON.stringify(x), x);
          cur[k] = [...by.values()];
        } else cur[k] = v;
      }
      pending.set(got.origin, cur);
      if (!timer) timer = weak(setT(() => { timer = null; void this_.flush(); }, FLUSH_MS));
    },
    /** A step could not find a control the card knows: queue one miss for that fact. @param {{ op: string, args?: any, error?: any, tabUrl?: string }} o */
    miss(o) {
      if (!enabled) return;
      const origin = originOf(String(o.tabUrl || ""));
      const c = origin ? cards.get(origin) : null;
      let r; try { r = observeMiss({ ...o, card: c ? c.card : null }); } catch { return; }
      if (!r) return;
      reports.set(`${r.origin}|${r.part}|${r.id}`, r);
      if (!timer) timer = weak(setT(() => { timer = null; void this_.flush(); }, FLUSH_MS));
    },
    /**
     * A rung worked on this page (1 api, 2 dom, 3 devtools, 4 ax, 5 picture): structure only, the page's own path reduced to a template and an integer. lowerFailed is true only when the lower
     * rungs really failed in this call chain. The store does the counting; a rung is re-sent at most every 10 minutes from here.
     * @param {{ tabUrl?: string, rung: number, lowerFailed?: boolean }} o
     */
    rung(o) {
      if (!enabled || !Number.isInteger(o.rung) || o.rung < 1 || o.rung > 5) return;
      let u; try { u = new URL(String(o.tabUrl || "")); } catch { return; }
      const origin = originOf(u.href), template = canonTemplate(u.pathname);
      if (!origin || !template) return;
      const key = `${origin}|${template}|${o.rung}`;
      if (now() - (rungSent.get(key) || 0) < 10 * 60_000 && !o.lowerFailed) return;
      rungPending.set(key, { origin, template, rung: o.rung, lowerFailed: o.lowerFailed === true });
      if (!timer) timer = weak(setT(() => { timer = null; void this_.flush(); }, FLUSH_MS));
    },
    /** Where the ladder started last time on this page template, from the card: a HINT for where to begin, never a permission (every check applies whatever rung is used). @param {string} url @returns {number|null} */
    startRung(url) {
      if (!enabled) return null;
      let u; try { u = new URL(String(url)); } catch { return null; }
      const origin = originOf(u.href), template = canonTemplate(u.pathname);
      const c = origin ? cards.get(origin) : null;
      const r = c && c.card && c.card.startRungs && template ? c.card.startRungs[template] : null;
      return Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
    },
    /** Clean and send every origin's queue. Returns what was sent, for tests. */
    async flush() {
      if (timer) { clearT(timer); timer = null; }
      /** @type {Array<{ origin: string, patch: any }>} */ const out = [];
      for (const r of [...reports.values()].slice(0, 20)) { emit({ event: "site.report", origin: r.origin, part: r.part, id: r.id, outcome: "miss" }); stats.sent++; }
      reports.clear();
      for (const [k, r] of [...rungPending]) { emit({ event: "site.report", origin: r.origin, template: r.template, rung: r.rung, lowerFailed: r.lowerFailed }); rungSent.set(k, now()); stats.sent++; }
      rungPending.clear();
      for (const [origin, patch] of [...pending]) {
        pending.delete(origin);
        const s = sanitize(patch);
        stats.dropped += s.dropped.length;
        if (!s.ok) { stats.refused++; continue; } // a secret-shaped field: nothing of this observation leaves the browser
        // What goes on the wire is the observation's own items that the allowlist KEPT, with the evidence they carry (two visits, container, siblings): the store cleans them again,
        // and it needs that evidence to keep a label or an identifier. (The cleaned record itself has the evidence stripped, so it cannot be sent.)
        const kept = { key: patch.key, ...(patch.family ? { family: patch.family } : {}), ...(patch.names ? { names: patch.names } : {}), ...(patch.related ? { related: patch.related } : {}) };
        const EVIDENCE = ["container", "siblings", "nameVisits", "identifierVisits", "choicesContainer", "choicesVisits"];
        for (const part of ["controls", "api", "frames"]) {
          const rawById = new Map((Array.isArray(patch[part]) ? patch[part] : []).map((/** @type {any} */ x) => [x.id, x]));
          // The CLEANED item (what the local allowlist kept, a label it dropped stays dropped) with only the evidence fields of the observation put back: the store needs them and cleans again.
          const items = (s.record[part] || []).map((/** @type {any} */ c) => { const raw = /** @type {any} */ (rawById.get(c.id)) || {}; const ev = /** @type {any} */ ({}); for (const k of EVIDENCE) if (raw[k] !== undefined) ev[k] = raw[k]; return { ...c, ...ev }; });
          if (items.length) /** @type {any} */ (kept)[part] = items;
        }
        emit({ event: "site.put", origin, patch: kept });
        // What this device just taught the store makes its copy of the card out of date: the next arrival asks again (at once, not after the usual wait).
        asked.delete(origin); { const cc = cards.get(origin); if (cc) cc.at = 0; }
        stats.sent++;
        out.push({ origin, patch: kept });
      }
      return out;
    },
    /** The card for an origin, rebuilt from a full record the server sent. @param {any} record */
    async setRecord(record) { if (record && record.key) await this_.setCard(record.key, arrivalCard(record), record.rev); },
    choicesVisits,
    /** The length of a visit, from the person's config (30 minutes by default). @param {number} ms */
    setVisitMs(ms) { visitMs = Number.isFinite(ms) && ms >= 1000 ? Math.round(ms) : DEFAULT_VISIT_MS; },
    /** @param {boolean} on */
    setEnabled(on) { enabled = !!on; if (!enabled) { pending.clear(); cards.clear(); labels.clear(); } },
    enabled: () => enabled,
    stats: () => ({ enabled, ...stats, origins: cards.size, pending: pending.size }),
  };
  this_ = api;
  return api;
}
