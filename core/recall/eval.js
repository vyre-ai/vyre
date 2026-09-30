// @ts-check
// eval — how well does search find what someone meant? Measured, not argued.
//
// A labelled set is a list of questions, each with the turns that answer it:
//   { "queries": [{ "q": "...", "answers": [{ "session": "...", "seq": 3 }] }], "nonsense": ["..."] }
// Every question runs three ways: keyword only, dense only, and hybrid (what recall.search does).
// For each it reports MRR@k (1 over the rank of the first answer, 0 if none in the top k,
// averaged) and recall@k (the share of a question's answers in the top k, averaged).
//
// It also checks the dense floor from both sides. Nonsense questions should get no dense
// candidates at all; answer turns scored below the floor are ones meaning can never reach.
// Hits are counted per turn with no cap per session, because the answers are turns.

import { search, floorFor, DENSE_K } from "./search.js";

/**
 * @typedef {{ session: string, seq: number }} Answer
 * @typedef {{ q: string, answers: Answer[] }} Case
 * @typedef {{ mrr: number, recall: number }} Score
 */

const round = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
const key = (/** @type {{ session: string, seq: number }} */ a) => a.session + "\0" + Number(a.seq);

/** MRR and recall for one ranked list of turn keys. */
function score(/** @type {string[]} */ ranked, /** @type {Answer[]} */ answers, k) {
  const want = new Set(answers.map(key));
  const top = ranked.slice(0, k);
  const first = top.findIndex(r => want.has(r));
  return { rr: first < 0 ? 0 : 1 / (first + 1), recall: want.size ? top.filter(r => want.has(r)).length / want.size : 0 };
}

/**
 * Run a labelled set.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ queries: Case[], nonsense?: string[] }} set
 * @param {{ embedder?: import("./embed.js").Embedder | null, dense?: import("./dense.js").Dense | null, k?: number, floor?: number, dense_weight?: number, z?: number }} [opts]
 */
export async function evaluate(db, set, { embedder = null, dense = null, k = 10, ...knobs } = {}) {
  const queries = (set.queries || []).filter(c => c && c.q && Array.isArray(c.answers) && c.answers.length);
  const meaning = Boolean(embedder && dense && (await dense.size()) > 0);
  const n = meaning && dense ? await dense.size() : 0;
  const floor = knobs.floor ?? floorFor(n);
  const z = knobs.z;
  const userWeight = knobs.user_weight;
  /** @type {Map<number, string>} rowid -> turn key, for the dense-only ranking */
  const byRid = new Map();
  if (meaning) for (const r of /** @type {any[]} */ (db.prepare("SELECT rowid AS rid, session, seq FROM recall_turns").all())) byRid.set(Number(r.rid), key(r));

  const sum = { keyword: { rr: 0, recall: 0 }, dense: { rr: 0, recall: 0 }, hybrid: { rr: 0, recall: 0 } };
  const answerScores = [];
  let belowFloor = 0, answers = 0;
  for (const c of queries) {
    const kw = (await search(db, { q: c.q, limit: k, per_session: 0 })).hits.map(key);
    const s = score(kw, c.answers, k);
    sum.keyword.rr += s.rr; sum.keyword.recall += s.recall;
    if (!meaning || !embedder || !dense) continue;
    const qv = await embedder.embed(c.q);
    // Every turn, best first, with no floor: the raw dense ranking, and each answer's raw score.
    const all = await dense.search(qv, { k: Infinity, floor: -1, userWeight });
    // The SAME gate search() would actually apply (floor, and z if given), for the dense-only
    // score and for the below-floor count: effectiveFloor may be higher than the flat floor.
    const gated = await dense.search(qv, { k: DENSE_K, floor, z, userWeight });
    const effFloor = gated.stats ? gated.stats.effectiveFloor : floor;
    const ranked = gated.map(h => byRid.get(h.rid) || "");
    const d = score(ranked, c.answers, k);
    sum.dense.rr += d.rr; sum.dense.recall += d.recall;
    const want = new Set(c.answers.map(key));
    for (const h of all) {
      if (!want.has(byRid.get(h.rid) || "")) continue;
      answerScores.push(h.score);
      if (h.score < effFloor) belowFloor++;
    }
    answers += want.size;
    const hy = (await search(db, { q: c.q, limit: k, per_session: 0, ...knobs }, embedder, dense)).hits.map(key);
    const y = score(hy, c.answers, k);
    sum.hybrid.rr += y.rr; sum.hybrid.recall += y.recall;
  }

  const nonsense = { n: 0, withDense: 0, withHits: 0, top: /** @type {number|null} */ (null) };
  for (const q of set.nonsense || []) {
    nonsense.n++;
    const hits = (await search(db, { q, limit: k, ...knobs }, meaning ? embedder : null, meaning ? dense : null)).hits;
    if (hits.length) nonsense.withHits++;
    if (!meaning || !embedder || !dense) continue;
    const qv = await embedder.embed(q);
    const raw = (await dense.search(qv, { k: 1, floor: -1, userWeight }))[0];
    const gated = await dense.search(qv, { k: 1, floor, z, userWeight });
    if (gated.length) nonsense.withDense++;
    if (raw) nonsense.top = Math.max(nonsense.top ?? -1, raw.score);
  }

  const m = queries.length || 1;
  const avg = (/** @type {{ rr: number, recall: number }} */ x) => ({ mrr: round(x.rr / m), recall: round(x.recall / m) });
  answerScores.sort((a, b) => a - b);
  return {
    queries: queries.length, k,
    keyword: avg(sum.keyword),
    dense: meaning ? avg(sum.dense) : null,
    hybrid: meaning ? avg(sum.hybrid) : null,
    floor: meaning ? {
      value: round(floor), chunks: n,
      answersBelow: belowFloor, answers,
      // How far the floor sits from each side: the weakest tenth of real answers, and the best
      // nonsense. A floor is safe when both gaps are comfortably positive.
      answerP10: answerScores.length ? round(answerScores[Math.floor(answerScores.length * 0.1)]) : null,
      nonsenseTop: nonsense.top === null ? null : round(nonsense.top),
    } : null,
    nonsense: { n: nonsense.n, withDense: nonsense.withDense, withHits: nonsense.withHits },
  };
}
