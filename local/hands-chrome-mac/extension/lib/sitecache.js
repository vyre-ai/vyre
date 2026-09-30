// @ts-check
// sitecache: what Vyre for Chrome knows about the sites it works on, kept on this device and never waited for (team/0.2/chrome-learning-plan.md).
//
//   arrive(url)   the card for a page's origin, from memory, else from chrome.storage.local; nothing on a first visit. A miss asks the server once a minute.
//   learn(...)    an op that finished teaches something (observe.js); it is queued per origin.
//   flush()       every 10 s and at run end, each origin's queue is cleaned through the store's allowlist HERE first (a secret-shaped field means the
//                 observation is dropped and never leaves the browser), then sent as one {event:"site.put"}.
//   setCard(...)  the server answers a want with the card; it is kept for the next arrival.
//
// Labels: a control's label goes on the wire only when this device has seen the same text on two separate visits (the 30-minute windows a person's
// use of a site falls in); a label seen once is remembered here and never sent.

import { sanitize, arrivalCard } from "../shared/sk/site-knowledge.js";
import { observeOp, originOf } from "./observe.js";

export const FLUSH_MS = 10_000;
export const STALE_MS = 10 * 60_000;
export const WANT_EVERY_MS = 60_000;
const VISIT_MS = 30 * 60_000;
const MAX_LABELS = 400;

/**
 * @param {{ chrome?: any, emit?: (evt: any) => void, now?: () => number, setT?: any, clearT?: any }} [o]
 */
export function createSiteCache({ chrome, emit = () => {}, now = Date.now, setT = setTimeout, clearT = clearTimeout } = {}) {
  /** @type {Map<string, { card: any, rev: number, at: number }>} */ const cards = new Map();
  /** @type {Map<string, Record<string, any>>} */ const pending = new Map();
  /** @type {Map<string, number>} */ const asked = new Map();
  /** label text by origin and key: the visits that saw it. @type {Map<string, Map<string, { text: string, visits: Set<string> }>>} */ const labels = new Map();
  /** @type {any} */ let timer = null;
  /** @type {any} */ let this_ = null;
  const stats = { learned: 0, sent: 0, refused: 0, dropped: 0 };
  const visit = () => `v${Math.floor(now() / VISIT_MS)}`;
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
      if (!origin) return null;
      const have = await load(origin);
      const t = now();
      if ((!have || t - have.at > STALE_MS) && t - (asked.get(origin) || 0) > WANT_EVERY_MS) { asked.set(origin, t); emit({ event: "site.want", origin, ...(have ? { since_rev: have.rev } : {}) }); }
      return have ? have.card : null;
    },
    /** What the server sent. @param {string} origin @param {any} card @param {number} rev */
    async setCard(origin, card, rev) {
      if (!originOf(origin) || !card || typeof card !== "object") return;
      const v = { card, rev: Number(rev) || 0, at: now() };
      cards.set(origin, v);
      if (store) { try { await store.set({ [`site:${origin}`]: v }); } catch { /* storage full or gone */ } }
    },
    /** @param {string} origin */
    card(origin) { const c = cards.get(origin); return c ? c.card : null; },
    /** An op finished: queue what it taught. @param {{ op: string, args?: any, result?: any, tabUrl?: string }} o */
    learn(o) {
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
    /** Clean and send every origin's queue. Returns what was sent, for tests. */
    async flush() {
      if (timer) { clearT(timer); timer = null; }
      /** @type {Array<{ origin: string, patch: any }>} */ const out = [];
      for (const [origin, patch] of [...pending]) {
        pending.delete(origin);
        const s = sanitize(patch);
        stats.dropped += s.dropped.length;
        if (!s.ok) { stats.refused++; continue; } // a secret-shaped field: nothing of this observation leaves the browser
        emit({ event: "site.put", origin, patch: s.record });
        stats.sent++;
        out.push({ origin, patch: s.record });
      }
      return out;
    },
    /** The card for an origin, rebuilt from a full record the server sent. @param {any} record */
    async setRecord(record) { if (record && record.key) await this_.setCard(record.key, arrivalCard(record), record.rev); },
    stats: () => ({ ...stats, origins: cards.size, pending: pending.size }),
  };
  this_ = api;
  return api;
}
