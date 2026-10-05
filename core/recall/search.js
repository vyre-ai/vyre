// @ts-check
// search — find the turns that answer a question, by their words and by their meaning.
//
// Two ways into the candidate pool. FTS5 finds turns that share words with the question, first
// as typed (strict) and then any of its words (loose). The dense index (dense.js) finds turns
// whose MEANING is close, which is the only way to reach a turn that shares no word with the
// question: "making it easier for blind visitors" against an accessibility audit. Measured on a
// real 100k-turn corpus, dense retrieval beat full-text plus re-ranking, MRR 0.195 against 0.142.
//
// The two rankings are merged by reciprocal rank rather than by blending a position with a
// cosine. A blend let hundreds of loose keyword matches, each sharing one common word, bury a
// turn that meaning alone had found; by rank, the best of each list starts level.
//
// Merging may reorder and add. It may NOT lose an exact match. Most of what a technical corpus is
// asked for is a literal string (an error message, an id, a path), and a ranker that sinks the
// one turn containing it is worse than none. So the top half of the STRICT keyword answer is
// pinned into the result before anything else is consulted: a guarantee by construction.


import { keysFor } from "./turns.js";

/** The text spelled so FTS5 reads it as one literal phrase rather than as grammar. */
export const phrase = (/** @type {string} */ q) => '"' + String(q).replace(/"/g, '""') + '"';

// Words that are in every turn cost a full scan and add nothing to the ordering.
const STOP = new Set(("the a an and or of to in for on is are was were be been it its this that " +
  "we i you he she they do does did how what when where why which who with from as at by so if " +
  "not no but can could should would will just have has had our your my me us them then than").split(" "));

/**
 * The question as an OR of its words, each quoted. A question asked in a sentence shares two or
 * three words with its answer, never all of them, and FTS5 reads bare words as AND; this is the
 * widening pass that gives the re-ranker something to rank. Capped, so a pasted paragraph does
 * not become a sixty-term disjunction.
 */
export function anyOf(/** @type {string} */ q) {
  const words = String(q || "").toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_'-]*/gu) || [];
  const keep = [...new Set(words.filter(w => w.length > 1 && !STOP.has(w)))].slice(0, 16);
  return keep.length ? keep.map(phrase).join(" OR ") : phrase(q);
}

/**
 * The words typed so far, each as a prefix, all of them: "harl inta" finds "Harlow intake". For
 * completion while typing (memory.suggest, cohesion's suggest.query): no OR-widening, no meaning.
 */
export function prefixOf(/** @type {string} */ q) {
  const words = String(q || "").toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_'-]*/gu) || [];
  const keep = words.slice(0, 8);
  return keep.length ? keep.map(w => phrase(w) + "*").join(" ") : null;
}

/**
 * @typedef {{ q: string, limit?: number, project_cwds?: string[], sessions?: string[], role?: "user"|"assistant", hybrid?: boolean,
 *             per_session?: number, candidates?: number, floor?: number, dense_weight?: number, prefix?: boolean,
 *             links?: { kind?: string, ref: string }[] }} Query
 * links: keep only turns that touched these (core/recall/turns.js linkFilter), or sit next to one: a file named in an assistant turn often has its words in the turn before or after.
 * @typedef {{ session: string, seq: number, role: string, ts: number, text: string, snippet: string,
 *             score: number, name: string|null, title: string|null, cwd: string|null }} Hit
 */

/**
 * SQL that keeps sessions whose cwd is one of the folders or inside one, or that are one of the
 * sessions named (a project's attached sessions, wherever they ran).
 */
function underAny(/** @type {string[]} */ cwds, /** @type {string[]} */ sessions = []) {
  if (!cwds.length && !sessions.length) return { sql: "", args: [] };
  const clean = cwds.map(c => String(c).replace(/\/+$/, "")).filter(Boolean);
  const ids = sessions.map(String).filter(Boolean);
  if (!clean.length && !ids.length) return { sql: " AND 0", args: [] };
  const parts = [...clean.map(() => "s.cwd = ? OR substr(s.cwd, 1, ?) = ?"), ...(ids.length ? [`s.id IN (${ids.map(() => "?").join(",")})`] : [])];
  return { sql: " AND (" + parts.join(" OR ") + ")", args: [...clean.flatMap(c => [c, c.length + 1, c + "/"]), ...ids] };
}

/**
 * Candidate turns for one FTS5 expression, best first. People do not type FTS5's grammar: a
 * hyphenated repo name parses as a column filter and half a parenthesis is a syntax error. So
 * the query runs as given (someone who knows the grammar still gets it) and, when FTS5 refuses
 * it, as the literal phrase instead of crashing.
 */
function match(db, expr, { role, cwds, sessions, limit }) {
  const where = underAny(cwds, sessions);
  const sql = `SELECT t.rowid AS rid, t.session, t.seq, t.role, t.ts, t.text, t.rank AS rank,
      snippet(recall_turns, 4, '«', '»', '…', 16) AS snippet,
      s.name, s.title, s.cwd
    FROM recall_turns t JOIN recall_sessions s ON s.id = t.session
    WHERE recall_turns MATCH ?${role ? " AND t.role = ?" : ""}${where.sql}
    ORDER BY t.rank LIMIT ?`;
  const args = [...(role ? [role] : []), ...where.args, limit];
  try { return db.prepare(sql).all(expr, ...args); }
  catch {
    try { return db.prepare(sql).all(phrase(expr), ...args); } catch { return []; }
  }
}

/**
 * How close a dense hit must be to count, for a corpus of n chunks. Without a floor every query
 * has a nearest neighbour, and nonsense would return results.
 *
 * It rises with the corpus, because the best score pure noise reaches does: the expected maximum
 * of n noise scores grows like sqrt(2 ln n). Fitted to two measurements with the real model:
 *   16 fixture turns    nonsense at most 0.186, the questions meant 0.339 and 0.473
 *   36,878 real chunks  nonsense at most 0.413, the weakest real question's best 0.476
 * giving 0.276 and 0.444. The margins are a few hundredths at the real corpus's size, which is
 * why it is capped: past that, a stricter floor starts losing real questions instead.
 */
export function floorFor(/** @type {number} */ n) {
  return Math.min(0.45, Math.max(0.25, 0.10 + 0.075 * Math.sqrt(2 * Math.log(Math.max(2, n)))));
}
/**
 * A second, PER-QUERY floor on top of floorFor's fixed one: mean + z * stddev of this query's
 * own dot products (see dense.js `search`). Left off (undefined) by default: on the real
 * labelled set it could not clear the best English-sounding nonsense probes without also
 * burying real answers (docs/work/recall.md has the sweep), so agreement gating (below) and
 * `USER_WEIGHT` carry the real fix and this stays a knob for the eval harness to keep testing.
 */
export const Z = undefined;
/** How many turns meaning may add to the pool. */
export const DENSE_K = 200;
/**
 * The reciprocal-rank constant. The earlier rank-fusion-k sweep (docs/work/recall.md) tested
 * only the assistant-only variant at dense_weight 0.05-0.08, where 60 held up; re-swept on the
 * SHIPPED all-role index at dense_weight 0.2-0.3 it does not: rrf_k pushes a keyword rank down
 * faster than a dense rank at the SAME rrf_k when dense_weight < 1, so at 60 a candidate ranked
 * ~5th by keyword but 1st by dense could already outscore the true top keyword answer sitting
 * alone at rank 0 (score 0.8 vs 0.94 at k=60, worked out in the sweep) — the exact shape of the
 * "kw wins" failures a differential pass over real queries turned up (recall.md). A smaller k
 * sharpens the top of BOTH lists relative to their tails, so a lone strong keyword match is no
 * longer outrun by a weaker one riding dense agreement. Swept 5/8/10/12/20/30/45 x dense_weight
 * 0.15-0.35 on the real corpus, cross-checked against the fictional set every time: rrf_k 10 at
 * dense_weight 0.25 (unchanged) was the best point found — real hybrid MRR 0.549 -> 0.597,
 * recall 0.887 -> 0.897, fictional hybrid MRR/recall unchanged at 0.881/0.821 (no regression),
 * nonsense false-positive rate unchanged at 1/30 (the floor is untouched by rrf_k). This is the
 * first change in this pass that clears keyword's own MRR (0.572) outright. See recall.md.
 */
export const RRF = 10;
/**
 * How much a dense rank counts against a keyword rank. Re-swept after agreement gating (above)
 * changed what floor-only exclusion is for: on the real labelled set, at USER_WEIGHT 1, hybrid
 * MRR/recall@10 were 0.58/0.866 at 0.05, 0.57/0.876 at 0.1, 0.549/0.887 at 0.25 (kept), against
 * keyword's 0.572/0.866. Lower weights get closer to (0.05: past) keyword's MRR on the real
 * corpus, but every weight under 0.25 also drops the FICTIONAL set's hybrid MRR from 0.881 to
 * 0.81 (still above the pre-this-branch 0.845, but a real step down from 0.25's own 0.881) —
 * apparently a rank-ordering threshold in that small a corpus, not a smooth tradeoff. Kept at
 * 0.25 because the fictional set is the one measurement here that must not regress; re-checked
 * against the retuned rrf_k (10) above and still the best point. See docs/work/recall.md.
 */
export const DENSE_WEIGHT = 0.25;
/**
 * How much a USER turn's dense score counts, before ranking (1 = unchanged). Tried at 0.5 to
 * de-emphasise the real corpus's short commands and pasted errors (3,903 user turns next to
 * 20,654 assistant ones, sharing the same 384-dim space): it recovered most of an outright
 * "assistant only" index's real-corpus gain without excluding user turns outright, BUT a weight
 * strong enough to matter (0.5-0.7) also sinks the fictional set's one dense-only case ("blind
 * visitors" is answered entirely by a USER turn, no assistant turn stands in for it, and its
 * fake-embedder score has too little margin over the fixture's tiny-corpus floor to survive a
 * 30-50% cut) below the floor entirely: `recall: meaning alone finds a turn that shares no word
 * with the question` fails at any weight under about 0.82, at which point it is not doing
 * anything on the real corpus either. Left at 1 (off) for that reason; DENSE_WEIGHT and the
 * agreement-gated floor above already clear keyword on the real corpus without it. Kept as an
 * eval-harness knob in case a future labelled set, or a length-based rather than role-based
 * version of the same idea, makes it safe. See docs/work/recall.md.
 */
export const USER_WEIGHT = 1;

/**
 * Search. Hybrid when there are vectors and an embedder, keyword otherwise; every way the
 * meaning half can fail (no model, no vectors yet, a model that throws) ends in the keyword
 * answer rather than an exception. Search is what people reach for when something has already
 * gone wrong; it is the wrong moment for it to be the thing that is wrong.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {Query} query
 * @param {import("./embed.js").Embedder | null} [embedder]
 * @param {import("./dense.js").Dense | null} [dense]
 * @returns {Promise<{ hits: Hit[], hybrid: boolean }>}
 */
export async function search(db, query, embedder = null, dense = null) {
  if (query.links && query.links.length) {
    const keys = keysFor(db, query.links);
    if (keys) {
      if (!keys.size) return { hits: [], hybrid: false };
      const near = new Set();
      for (const k of keys) { const [session, seq] = k.split("\0"); for (const d of [-1, 0, 1]) near.add(session + "\0" + (Number(seq) + d)); }
      const limit = Math.max(1, Math.min(100, query.limit || 10));
      const { links: _, ...rest } = query;
      const r = await search(db, { ...rest, limit: 100, per_session: 0, candidates: Math.max(query.candidates || 300, 1000) }, embedder, dense);
      return { hits: r.hits.filter(h => near.has(h.session + "\0" + h.seq)).slice(0, limit), hybrid: r.hybrid };
    }
  }
  const q = String(query.q || "").trim();
  const limit = Math.max(1, Math.min(100, query.limit || 10));
  const cap = query.per_session === undefined ? 3 : query.per_session;
  if (!q) return { hits: [], hybrid: false };
  const opts = { role: query.role, cwds: query.project_cwds || [], sessions: query.sessions || [] };
  const wide = Math.max(query.candidates || 300, limit * 4);
  if (query.prefix) {
    const expr = prefixOf(q);
    if (!expr) return { hits: [], hybrid: false };
    const rows = match(db, expr, { ...opts, limit: Math.max(limit * 4, 40) });
    const per = new Map(), hits = [];
    for (const c of rows) {
      if (hits.length >= limit) break;
      const had = per.get(c.session) || 0;
      if (cap && had >= cap) continue;
      per.set(c.session, had + 1);
      hits.push({ session: String(c.session), seq: Number(c.seq), role: String(c.role), ts: Number(c.ts), text: String(c.text),
        snippet: String(c.snippet || String(c.text).slice(0, 200)).replace(/\s+/g, " "), score: Math.round((1 / (1 + hits.length)) * 1000) / 1000,
        name: c.name ?? null, title: c.title ?? null, cwd: c.cwd ?? null });
    }
    return { hits, hybrid: false };
  }

  // The question as typed (AND: the pinned ordering) and then its words ORed together (the
  // reach), deduplicated, strict first. A query with quotes in it was written in FTS5's grammar
  // on purpose, and widening "intake form" into intake OR form would answer another question.
  const strict = match(db, q, { ...opts, limit: wide });
  const widen = !q.includes('"') && strict.length < wide;
  const loose = widen ? match(db, anyOf(q), { ...opts, limit: wide - strict.length }) : [];
  /** @type {Map<number, any>} */
  const pool = new Map();
  [...strict, ...loose].forEach(c => { if (!pool.has(c.rid)) { c.krank = pool.size; pool.set(c.rid, c); } });

  // Meaning, when there is something to compare against. The floor only guards the DENSE-ONLY
  // reach: a candidate keyword already vouches for is admitted at whatever rank meaning ranked
  // it, because keyword sharing an actual word with the question is already evidence enough;
  // the floor exists for the case meaning is the ONLY reason a turn is in the pool at all.
  let used = false;
  if (embedder && dense && query.hybrid !== false) {
    try {
      const qv = await embedder.embed(q);
      const cwds = opts.cwds.map(c => String(c).replace(/\/+$/, "")).filter(Boolean);
      const ids = new Set(opts.sessions.map(String));
      const keep = cwds.length || ids.size ? (/** @type {string|null} */ cwd, /** @type {string} */ session) => ids.has(session) || (!!cwd && cwds.some(c => cwd === c || cwd.startsWith(c + "/"))) : undefined;
      const floor = query.floor ?? floorFor(await dense.size());
      const z = query.z ?? Z;
      // Unfiltered by the floor: agreement with keyword is itself a way past it, decided below.
      const near = await dense.search(qv, { k: DENSE_K, floor: -1, role: opts.role, keep, userWeight: query.user_weight ?? USER_WEIGHT });
      const effectiveFloor = z !== undefined && near.stats ? Math.max(floor, near.stats.mean + z * near.stats.std) : floor;
      used = (dense.stats()?.chunks || 0) > 0;
      const fetch = db.prepare(`SELECT t.rowid AS rid, t.session, t.seq, t.role, t.ts, t.text, s.name, s.title, s.cwd
        FROM recall_turns t JOIN recall_sessions s ON s.id = t.session WHERE t.rowid = ?`);
      near.forEach((h, i) => {
        let c = pool.get(h.rid);
        const corroborated = Boolean(c);
        if (!corroborated && h.score < effectiveFloor) return;   // meaning alone, and not close enough
        if (!c) {
          c = /** @type {any} */ (fetch.get(h.rid));
          // The snapshot may be older than the table: a rowid reused for another turn is skipped.
          if (!c || c.session !== h.session || Number(c.seq) !== h.seq) return;
          c.snippet = null;
          pool.set(h.rid, c);
        }
        c.drank = i;
        c.voff = h.off;
      });
    } catch { used = false; }
  }
  if (!pool.size) return { hits: [], hybrid: used };

  // floor, dense_weight and rrf_k are knobs for the eval harness, not part of the tool's input.
  const dw = query.dense_weight ?? DENSE_WEIGHT;
  const rrfK = query.rrf_k ?? RRF;
  const top = (1 + dw) / (rrfK + 1);
  for (const c of pool.values()) {
    const r = (c.krank !== undefined ? 1 / (rrfK + 1 + c.krank) : 0) + (c.drank !== undefined ? dw / (rrfK + 1 + c.drank) : 0);
    c.score = used ? r / top : r * (rrfK + 1);
  }

  const perSession = new Map();
  const chosen = new Map();
  const take = c => {
    if (chosen.size >= limit || chosen.has(c.rid)) return;
    const had = perSession.get(c.session) || 0;
    if (cap && had >= cap) return;
    perSession.set(c.session, had + 1);
    chosen.set(c.rid, c);
  };
  // Half the slots, rounded up, belong to the strict keyword answer and are filled first. That is
  // what makes "hybrid never loses an exact match" a property rather than a tendency.
  const pinned = Math.ceil(limit / 2);
  for (const c of strict) { if (chosen.size >= pinned) break; take(pool.get(c.rid)); }
  for (const c of [...pool.values()].sort((a, b) => b.score - a.score)) take(c);

  const hits = [...chosen.values()].sort((a, b) => b.score - a.score).map(c => ({
    session: String(c.session), seq: Number(c.seq), role: String(c.role), ts: Number(c.ts), text: String(c.text),
    // A meaning hit that did not match the words shows the chunk its score came from. Citing an
    // answer and showing a different line is how a system that is right stops being believed.
    snippet: String(c.snippet && c.snippet.includes("«") ? c.snippet : String(c.text).slice(c.voff || 0, (c.voff || 0) + 200)).replace(/\s+/g, " "),
    score: Math.round(c.score * 1000) / 1000,
    name: c.name ?? null, title: c.title ?? null, cwd: c.cwd ?? null,
  }));
  return { hits, hybrid: used };
}

/**
 * One session and its turns, in order. Takes a full id or an unambiguous prefix, because that
 * is what a person copies out of a listing.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function thread(db, { session, from = 0, limit = 200 }) {
  let row = db.prepare("SELECT * FROM recall_sessions WHERE id = ?").get(session);
  if (!row) {
    const like = db.prepare("SELECT * FROM recall_sessions WHERE substr(id, 1, ?) = ? LIMIT 2").all(session.length, session);
    if (like.length > 1) throw new Error(`more than one session starts with ${session}`);
    row = like[0];
  }
  if (!row) throw new Error(`no session ${session}`);
  // id and at are what a live session.turn carries too (recall.watch), so one renderer draws both:
  // a text turn's id is its seq as a string.
  const turns = db.prepare("SELECT seq, role, ts, text FROM recall_turns WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?")
    .all(row.id, from, Math.max(1, Math.min(2000, limit)))
    .map(t => ({ id: String(t.seq), ...t, at: t.ts }));
  return { session: row, turns };
}

/**
 * Sessions, newest first. ids keeps only those exact session ids (at most 1000), which is how
 * the box resolves a Mac session picked into one of its projects.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ cwd?: string, since?: number, human?: boolean, limit?: number, ids?: string[] }} [opts]
 */
export function sessions(db, { cwd, since, human, limit = 50, ids } = {}) {
  const where = [], args = [];
  if (Array.isArray(ids)) {
    const list = [...new Set(ids.map(String).filter(Boolean))].slice(0, 1000);
    if (!list.length) return [];
    where.push(`s.id IN (${list.map(() => "?").join(",")})`);
    args.push(...list);
  }
  if (cwd) { const u = underAny([cwd]); where.push(u.sql.replace(/^ AND /, "")); args.push(...u.args); }
  if (since) { where.push("s.ended >= ?"); args.push(since); }
  if (human !== undefined) { where.push("s.human = ?"); args.push(human ? 1 : 0); }
  return db.prepare(`SELECT s.id, s.file, s.cwd, s.name, s.title, s.started, s.ended, s.turns, s.human, s.parent
    FROM recall_sessions s ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.ended DESC LIMIT ?`).all(...args, Math.max(1, Math.min(1000, limit)));
}
