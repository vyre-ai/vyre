// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/protocol/src/search/text-match.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, no typo tier, only what the composer's pickers use.
//
// Ranked text matching for the composer's pickers ("/" commands, "@" mentions). A match is a
// tier plus the offset it was found at; lower is better on both, so callers sort ascending.
// No DOM: shared core, tested on its own (match.test.js).

/** Exact tiers, best to worst. */
const TIER_EXACT = 0;
const TIER_WHOLE_WORD = 1;
const TIER_PREFIX = 2;
const TIER_WORD_START = 3;
const TIER_SUBSTRING = 4;
const TIER_SUBSEQUENCE = 5;

/** @typedef {{ tier: number, offset: number, spread?: number }} MatchScore */

/** @param {string|undefined} ch */
const boundary = ch => ch === undefined || !/[a-z0-9]/.test(ch);

/** @param {string} q @param {string} t @returns {MatchScore|null} */
function substring(q, t) {
  /** @type {MatchScore|null} */ let best = null;
  let pos = 0;
  while (pos <= t.length - q.length) {
    const at = t.indexOf(q, pos);
    if (at === -1) break;
    const starts = at === 0 || boundary(t[at - 1]);
    const ends = boundary(t[at + q.length]);
    const tier = starts && ends ? TIER_WHOLE_WORD : at === 0 ? TIER_PREFIX : starts ? TIER_WORD_START : TIER_SUBSTRING;
    if (!best || tier < best.tier || (tier === best.tier && at < best.offset)) best = { tier, offset: at };
    pos = at + 1;
  }
  return best;
}

/** The query's characters in order within one word: "nwb" finds "northwind-bakery". @param {string} q @param {string} t @returns {MatchScore|null} */
function subsequence(q, t) {
  let qi = 0, first = -1, last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (/\s/u.test(t[ti])) { qi = 0; first = -1; last = -1; continue; }
    if (t[ti] !== q[qi]) continue;
    if (first === -1) first = ti;
    last = ti;
    qi++;
  }
  if (qi !== q.length || first === -1) return null;
  return { tier: TIER_SUBSEQUENCE, offset: first, spread: last - first + 1 };
}

/** @param {string} query @param {string} text @returns {MatchScore|null} */
export function scoreMatch(query, text) {
  if (!query) return { tier: TIER_EXACT, offset: 0 };
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (t === q) return { tier: TIER_EXACT, offset: 0 };
  return substring(q, t) ?? subsequence(q, t);
}

/** @param {MatchScore} a @param {MatchScore} b */
export function compareScores(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return (a.spread ?? 0) - (b.spread ?? 0);
}

/** @param {string} v */
function compact(v) {
  let value = "";
  /** @type {number[]} */ const offsets = [];
  for (let i = 0; i < v.length; i++) {
    if (!/[a-z0-9]/i.test(v[i])) continue;
    value += v[i].toLowerCase();
    offsets.push(i);
  }
  return { value, offsets };
}

/** A query against a whole path, separators included: "srcapp" finds "src/app.js". @param {string} query @param {string} path */
export function scorePath(query, path) {
  const direct = scoreMatch(query, path);
  if (direct) return direct;
  const cq = compact(query), cp = compact(path);
  if (!cq.value || !cp.value) return null;
  const s = scoreMatch(cq.value, cp.value);
  return s ? { ...s, offset: cp.offsets[s.offset] ?? s.offset } : null;
}

/**
 * Every whitespace token of the query must match some field; the tiers add up.
 * @param {string} query @param {string[]} fields @returns {MatchScore|null}
 */
export function scoreFields(query, fields) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { tier: TIER_EXACT, offset: 0, spread: 0 };
  const sum = { tier: 0, offset: 0, spread: 0 };
  for (const token of tokens) {
    /** @type {MatchScore|null} */ let best = null;
    for (const f of fields) {
      const s = scoreMatch(token, f);
      if (s && (!best || compareScores(s, best) < 0)) best = s;
    }
    if (!best) return null;
    sum.tier += best.tier; sum.offset += best.offset; sum.spread += best.spread ?? token.length;
  }
  return sum;
}
