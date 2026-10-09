// @ts-check
// lib/tools-learn: tools_find learns from what happened next (follow-up (b)). When an agent asks tools_find for something and then really calls one of the tools it was shown, that pairing
// is written down here: the words of the ask (stemmed, no raw text) and the tool. Next time a similar ask comes, that tool scores a little higher. No model is involved.
//
// Private by construction: the file lives in the Vyre home it was learned in (mode 0600), holds word stems of the tool vocabulary (never a name or a number from an ask) and tool names only, never an input, an output or a result, and is read by
// nothing but the ranker on this machine; it is not synced, exported or sent. Small and bounded: 400 pairings, the least recently used out first. A boost is capped, so a habit can lift a
// tool past a near neighbour but never past a clearly better match, and a tool that no longer exists is never found, so its pairings do nothing.
import fs from "node:fs";
import path from "node:path";
import { terms } from "./docs-rank.js";

export const LIMITS = Object.freeze({ pairs: 400, terms: 12, overlap: 0.5, perUse: 0.2, cap: 0.6, windowMs: 10 * 60 * 1000 });

/** @param {string} query @returns {string[]} the distinct stems of an ask, at most a dozen */
export const stemsOf = (query, keep = () => true) => [...new Set(terms(query))].filter(keep).slice(0, LIMITS.terms).sort();

/**
 * @param {{ file?: string | null, now?: () => number, keep?: (stem: string) => boolean }} [o] `file` null keeps it in memory only; `keep` says which word stems may be written down (the server passes the words tools themselves are described with, so a name or a number in an ask is never kept)
 */
export function createLearner(o = {}) {
  const now = o.now || Date.now;
  /** @type {{ q: string[], tool: string, n: number, at: number }[]} */
  let pairs = [];
  if (o.file) { try { const j = JSON.parse(fs.readFileSync(o.file, "utf8")); if (j && Array.isArray(j.pairs)) pairs = j.pairs.filter((/** @type {any} */ p) => p && Array.isArray(p.q) && typeof p.tool === "string").slice(0, LIMITS.pairs); } catch { /* none yet */ } }
  const save = () => {
    if (!o.file) return;
    try { fs.mkdirSync(path.dirname(o.file), { recursive: true }); const tmp = `${o.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ pairs }), { mode: 0o600 }); fs.renameSync(tmp, o.file); } catch { /* learning is best effort */ }
  };
  const overlap = (/** @type {string[]} */ a, /** @type {string[]} */ b) => { const s = new Set(a); const inter = b.filter((x) => s.has(x)).length; return inter / (new Set([...a, ...b]).size || 1); };

  return {
    /** The agent asked `query`, was shown some tools, and called `tool`. @param {string} query @param {string} tool */
    note(query, tool) {
      const q = stemsOf(query, o.keep);
      if (q.length < 2 || !tool) return;
      const hit = pairs.find((p) => p.tool === tool && overlap(p.q, q) >= 0.8);
      if (hit) { hit.n++; hit.at = now(); } else pairs.push({ q, tool, n: 1, at: now() });
      if (pairs.length > LIMITS.pairs) { pairs.sort((a, b) => b.at - a.at); pairs = pairs.slice(0, LIMITS.pairs); }
      save();
    },
    /** A multiplier per tool for this ask: 1 plus what similar asks taught, capped. @param {string} query @returns {Map<string, number>} */
    boosts(query) {
      const q = stemsOf(query, o.keep), out = new Map();
      if (q.length < 2) return out;
      for (const p of pairs) { const ov = overlap(p.q, q); if (ov >= LIMITS.overlap) out.set(p.tool, (out.get(p.tool) || 0) + LIMITS.perUse * Math.min(p.n, 3) * ov); }
      return new Map([...out].map(([t, v]) => [t, 1 + Math.min(v, LIMITS.cap)]));
    },
    size: () => pairs.length,
    forget() { pairs = []; save(); },
  };
}
