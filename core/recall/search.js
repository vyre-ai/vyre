// @ts-check
// search — find the turns that answer a question, by words and then by meaning.
//
// FTS5 RETRIEVES, EMBEDDINGS RE-RANK. A keyword query narrows a hundred thousand turns to a few
// hundred candidates in milliseconds, and re-ranking a few hundred vectors is a few hundred dot
// products. No nearest-neighbour index to install or rebuild. The honest cost, written down
// rather than discovered: a turn sharing NO word with the question is never a candidate.
//
// Re-ranking may reorder and add. It may NOT lose an exact match. Most of what a technical corpus
// is asked for is a literal string (an error message, an id, a path), and a re-ranker that sinks
// the one turn containing it is worse than none. So the top half of the keyword answer is
// pinned into the result before blending fills the rest: a guarantee by construction, not a
// tendency of the weights.

import { cosine, decode } from "./embed.js";

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
 * @typedef {{ q: string, limit?: number, project_cwds?: string[], role?: "user"|"assistant", hybrid?: boolean,
 *             per_session?: number, candidates?: number, weight?: number }} Query
 * @typedef {{ session: string, seq: number, role: string, ts: number, text: string, snippet: string,
 *             score: number, name: string|null, title: string|null, cwd: string|null }} Hit
 */

/** SQL that keeps sessions whose cwd is one of the folders or inside one. */
function underAny(/** @type {string[]} */ cwds) {
  if (!cwds.length) return { sql: "", args: [] };
  const clean = cwds.map(c => String(c).replace(/\/+$/, "")).filter(Boolean);
  if (!clean.length) return { sql: " AND 0", args: [] };
  return {
    sql: " AND (" + clean.map(() => "s.cwd = ? OR substr(s.cwd, 1, ?) = ?").join(" OR ") + ")",
    args: clean.flatMap(c => [c, c.length + 1, c + "/"]),
  };
}

/**
 * Candidate turns for one FTS5 expression, best first. People do not type FTS5's grammar: a
 * hyphenated repo name parses as a column filter and half a parenthesis is a syntax error. So
 * the query runs as given (someone who knows the grammar still gets it) and, when FTS5 refuses
 * it, as the literal phrase instead of crashing.
 */
function match(db, expr, { role, cwds, limit }) {
  const where = underAny(cwds);
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
 * Search. Hybrid when there are vectors and an embedder, keyword otherwise; every way the
 * meaning half can fail (no model, no vectors yet, a model that throws) ends in the keyword
 * answer rather than an exception. Search is what people reach for when something has already
 * gone wrong; it is the wrong moment for it to be the thing that is wrong.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {Query} query
 * @param {import("./embed.js").Embedder | null} [embedder]
 * @returns {Promise<{ hits: Hit[], hybrid: boolean }>}
 */
export async function search(db, query, embedder = null) {
  const q = String(query.q || "").trim();
  const limit = Math.max(1, Math.min(100, query.limit || 10));
  const cap = query.per_session === undefined ? 3 : query.per_session;
  if (!q) return { hits: [], hybrid: false };
  const opts = { role: query.role, cwds: query.project_cwds || [] };
  const wide = Math.max(query.candidates || 300, limit * 4);

  // Two passes: the question as typed (AND, strict, the pinned ordering) and then its words ORed
  // together (the reach), deduplicated, strict first. A query with quotes in it was written in
  // FTS5's grammar on purpose, and widening "intake form" into intake OR form would answer a
  // different question, so it gets the strict pass only.
  const strict = match(db, q, { ...opts, limit: wide });
  const widen = !q.includes('"') && strict.length < wide;
  const loose = widen ? match(db, anyOf(q), { ...opts, limit: wide - strict.length }) : [];
  const seen = new Set(), cand = [];
  for (const c of [...strict, ...loose]) if (!seen.has(c.rid)) { seen.add(c.rid); cand.push(c); }
  if (!cand.length) return { hits: [], hybrid: false };

  // Meaning, when there is something to compare against.
  const sim = new Map();
  let used = false;
  if (embedder && query.hybrid !== false) {
    try {
      const qv = await embedder.embed(q);
      const vec = db.prepare("SELECT off, v FROM recall_vectors WHERE session = ? AND seq = ?");
      for (const c of cand) {
        for (const r of /** @type {any[]} */ (vec.all(c.session, c.seq))) {
          if (!r.v || !r.v.length) continue;
          const score = cosine(qv, decode(r.v));
          const best = sim.get(c.rid);
          if (!best || score > best.score) sim.set(c.rid, { score, off: Number(r.off) });
        }
      }
      used = sim.size > 0;
    } catch { used = false; }
  }

  // A bm25 rank and a cosine are on different scales, so the keyword side is scored by POSITION
  // in the candidate list, normalised to [0,1] like the cosine. The cosine is used raw, clamped at
  // zero: MiniLM puts unrelated text near 0.05 and a real match near 0.5, and rescaling [-1,1]
  // to [0,1] would squeeze away most of that range.
  const weight = query.weight ?? 0.5;
  const n = cand.length;
  cand.forEach((c, i) => {
    const k = n > 1 ? 1 - i / (n - 1) : 1;
    const v = sim.get(c.rid);
    c.k = k;
    c.blend = used ? (1 - weight) * k + weight * Math.max(0, Math.min(1, v ? v.score : 0)) : k;
    c.voff = v ? v.off : 0;
  });

  const perSession = new Map();
  const chosen = new Map();
  const take = c => {
    if (chosen.size >= limit || chosen.has(c.rid)) return;
    const had = perSession.get(c.session) || 0;
    if (cap && had >= cap) return;
    perSession.set(c.session, had + 1);
    chosen.set(c.rid, c);
  };
  // Half the slots, rounded up, belong to the keyword ordering and are filled before blending
  // is consulted. That is what makes "hybrid never loses what keyword found" a property.
  const pinned = Math.ceil(limit / 2);
  for (const c of cand) { if (chosen.size >= pinned) break; take(c); }
  for (const c of [...cand].sort((a, b) => b.blend - a.blend)) take(c);

  const hits = [...chosen.values()].sort((a, b) => b.blend - a.blend).map(c => ({
    session: String(c.session), seq: Number(c.seq), role: String(c.role), ts: Number(c.ts), text: String(c.text),
    // A meaning hit that did not match the words shows the chunk the cosine came from. Citing an
    // answer and showing a different line is how a system that is right stops being believed.
    snippet: String(c.snippet && c.snippet.includes("«") ? c.snippet : String(c.text).slice(c.voff, c.voff + 200)).replace(/\s+/g, " "),
    score: Math.round(c.blend * 1000) / 1000,
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
  const turns = db.prepare("SELECT seq, role, ts, text FROM recall_turns WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?")
    .all(row.id, from, Math.max(1, Math.min(2000, limit)));
  return { session: row, turns };
}

/**
 * Sessions, newest first.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ cwd?: string, since?: number, human?: boolean, limit?: number }} [opts]
 */
export function sessions(db, { cwd, since, human, limit = 50 } = {}) {
  const where = [], args = [];
  if (cwd) { const u = underAny([cwd]); where.push(u.sql.replace(/^ AND /, "")); args.push(...u.args); }
  if (since) { where.push("s.ended >= ?"); args.push(since); }
  if (human !== undefined) { where.push("s.human = ?"); args.push(human ? 1 : 0); }
  return db.prepare(`SELECT s.id, s.file, s.cwd, s.name, s.title, s.started, s.ended, s.turns, s.human, s.parent
    FROM recall_sessions s ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.ended DESC LIMIT ?`).all(...args, Math.max(1, Math.min(1000, limit)));
}
