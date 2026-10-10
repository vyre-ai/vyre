// @ts-check
// lib/tools-rank: the part of tools_find that learns from asks. Every tool has a bank of asks (what a person says when that tool is the right one, lib/tools-asks-bank.js); a new ask is scored
// against each tool two ways and the two lists are fused with the keyword ranking of lib/tools-index.js. Pure and deterministic, no model and no network: the same tools and asks give the same
// answer every time, so a ranking test can pin it.
//
//   centroid   the cosine between the ask and the sum of a tool's asks (tf-idf over words and word pairs): which tool's asks the ask resembles on the whole
//   bayes      the likelihood of the ask's words under a tool's asks (multinomial, add-0.1): a word only one family of tools is asked with ("text", "draft") decides
//
// Measured on asks written by authors who had not seen the tool list (test/fixtures/tools-find-dev.json, tools-find-sealed.json), the three views together beat the keyword ranking alone by
// 20 points at first place. A local embedding model (the one Recall uses, all-MiniLM-L6-v2) was tried as a further view and as a replacement: alone it was worse than either view above, and
// fused with them it added nothing, so there is none. The closest single ask of a tool (nearest neighbour) was tried too and added nothing over the centroid.

import { terms } from "./docs-rank.js";

/** Words and word pairs of a text, stemmed. @param {string} text */
export function features(text) {
  const t = terms(text);
  const out = [...t];
  for (let i = 0; i + 1 < t.length; i++) out.push(`${t[i]}_${t[i + 1]}`);
  return out;
}

/** @typedef {{ names: string[], centroids: Map<string, Map<string, number>>, norms: Map<string, number>, counts: Map<string, Map<string, number>>, totals: Map<string, number>, vocab: number, idf: (f: string) => number, knows: (f: string) => boolean }} AskModel */

const norm = (/** @type {Map<string, number>} */ m) => { let s = 0; for (const v of m.values()) s += v * v; return Math.sqrt(s) || 1; };

/**
 * The model of a set of tools and their asks.
 * @param {{ name: string, asks: string[] }[]} entries
 * @returns {AskModel}
 */
export function buildAskModel(entries) {
  const feats = entries.map((e) => e.asks.map(features));
  const df = new Map();
  let n = 0;
  for (const per of feats) for (const f of per) { n++; for (const x of new Set(f)) df.set(x, (df.get(x) || 0) + 1); }
  const idf = (/** @type {string} */ f) => Math.log(1 + n / (1 + (df.get(f) || 0)));
  /** @type {AskModel["centroids"]} */ const centroids = new Map();
  /** @type {AskModel["norms"]} */ const norms = new Map();
  /** @type {AskModel["counts"]} */ const counts = new Map();
  /** @type {AskModel["totals"]} */ const totals = new Map();
  entries.forEach((e, i) => {
    const c = new Map(), k = new Map();
    let total = 0;
    for (const f of feats[i]) {
      /** @type {Map<string, number>} */ const v = new Map();
      for (const x of f) { v.set(x, (v.get(x) || 0) + 1); k.set(x, (k.get(x) || 0) + 1); total++; }
      for (const [x, tf] of v) v.set(x, (1 + Math.log(tf)) * idf(x));
      const len = norm(v);
      for (const [x, w] of v) c.set(x, (c.get(x) || 0) + w / len);
    }
    centroids.set(e.name, c); norms.set(e.name, norm(c)); counts.set(e.name, k); totals.set(e.name, total);
  });
  return { names: entries.map((e) => e.name), centroids, norms, counts, totals, vocab: df.size, idf, knows: (f) => df.has(f) };
}

/**
 * The two ranked lists for a query, each every tool best first as [name, score].
 * @param {AskModel} model @param {string} query
 * @returns {{ centroid: [string, number][], bayes: [string, number][] }}
 */
export function rankAsks(model, query) {
  const fs = features(query);
  /** @type {Map<string, number>} */ const q = new Map();
  for (const f of fs) q.set(f, (q.get(f) || 0) + 1);
  for (const [f, v] of q) q.set(f, (1 + Math.log(v)) * model.idf(f));
  const qn = norm(q);
  const known = fs.filter((f) => model.knows(f));
  /** @param {(name: string) => number} score @returns {[string, number][]} */
  const rank = (score) => model.names.map((n) => /** @type {[string, number]} */ ([n, score(n)])).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    centroid: rank((n) => {
      const c = /** @type {Map<string, number>} */ (model.centroids.get(n));
      let d = 0;
      for (const [f, v] of q) { const w = c.get(f); if (w) d += v * w; }
      return d / (qn * /** @type {number} */ (model.norms.get(n)));
    }),
    bayes: rank((n) => {
      const c = /** @type {Map<string, number>} */ (model.counts.get(n)), total = /** @type {number} */ (model.totals.get(n));
      let s = 0;
      for (const f of known) s += Math.log(((c.get(f) || 0) + 0.1) / (total + 0.1 * model.vocab));
      return s;
    }),
  };
}

/**
 * Reciprocal-rank fusion: a tool's score is the sum over lists of 1 / (k + its rank), so a tool several views put near the top beats one a single view loves.
 * @param {{ name: string }[][]} lists each best first @param {{ k?: number, depth?: number }} [o]
 * @returns {{ name: string, score: number, ranks: number[] }[]} best first; `ranks` is the 0-based rank in each list (-1 when beyond depth)
 */
export function fuse(lists, o = {}) {
  const k = o.k ?? 10, depth = o.depth ?? 40;
  /** @type {Map<string, { score: number, ranks: number[] }>} */ const by = new Map();
  lists.forEach((l, li) => l.slice(0, depth).forEach((x, i) => {
    const e = by.get(x.name) || { score: 0, ranks: lists.map(() => -1) };
    e.score += 1 / (k + i); e.ranks[li] = i;
    by.set(x.name, e);
  }));
  return [...by].map(([name, e]) => ({ name, ...e })).sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
}
