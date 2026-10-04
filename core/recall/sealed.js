// @ts-check
// Sealed values never stay in Recall's index (0.3, the same rules as core/memory/sealed.js). A turn, a session title or a session name that holds a value shaped like a sealed class
// (kernel/seal/classes.js: SSN, card, bank, IBAN, EIN and the rest, spaces, dashes and spelled digits folded) is stored with a placeholder in place of the matched span, and nothing else
// in the text changes. Three doors:
//   `scrubText`  on the way in, for every new turn and title (the indexer calls it right after the credential redaction);
//   `scanIndex`  a look at what is already stored: table, column, rows and classes, never a value, and it changes nothing;
//   `scrubIndex` the owner-run rewrite of what is stored: only matched spans change, the vectors built from a changed turn are dropped (they embed the old text; the embedder makes new
//                ones), the dense copy is told to rebuild, and one log row (counts and classes, no value) is kept in recall_meta.
// What it cannot do is match a value that is sealed TODAY in some record by the sealing process's ledger; it finds what has the shape of a sealed class.
import { detect, redact } from "../../kernel/seal/classes.js";

/** @typedef {import("node:sqlite").DatabaseSync} DB */

/** @param {unknown} text @returns {{ text: string, classes: string[] }} */
export function scrubText(text) {
  const t = String(text ?? "");
  if (!detect(t).length) return { text: t, classes: [] };
  const r = redact(t);
  return { text: r.text, classes: [...new Set(r.found.map(f => f.class))] };
}

/** The columns Recall keeps text in. A vector row holds numbers only; it is reported with the turns it was made from. */
export const COLUMNS = Object.freeze([["recall_turns", "text"], ["recall_sessions", "title"], ["recall_sessions", "name"]]);

const LOG_KEY = "sealscrub_log";

/**
 * What the index holds that has the shape of a sealed value. Counts only, never a value.
 * @param {DB} db
 * @returns {{ found: { table: string, column: string, rows: number, classes: Record<string, number> }[], vectors: number }}
 */
export function scanIndex(db) {
  const found = [];
  let vectors = 0;
  for (const [table, column] of COLUMNS) {
    /** @type {Record<string, number>} */ const classes = {};
    let rows = 0;
    const q = db.prepare(`SELECT rowid AS id, ${column} AS v${table === "recall_turns" ? ", session, seq" : ""} FROM ${table} WHERE ${column} IS NOT NULL`);
    const hasVec = db.prepare("SELECT COUNT(*) AS n FROM recall_vectors WHERE session = ? AND seq = ?");
    for (const r of /** @type {any[]} */ (q.iterate())) {
      const { classes: cs } = scrubText(r.v);
      if (!cs.length) continue;
      rows++;
      for (const c of cs) classes[c] = (classes[c] || 0) + 1;
      if (table === "recall_turns") vectors += Number(/** @type {any} */ (hasVec.get(r.session, r.seq)).n);
    }
    if (rows) found.push({ table, column, rows, classes });
  }
  return { found, vectors };
}

/**
 * Rewrite the matched spans of what is stored. One transaction per batch of rows, so a stop leaves nothing half done and a second run finds what is left.
 * @param {DB} db @param {{ batch?: number, now?: () => number }} [o]
 * @returns {{ turns: number, titles: number, names: number, vectors: number, classes: Record<string, number> }}
 */
export function scrubIndex(db, { batch = 500, now = Date.now } = {}) {
  /** @type {Record<string, number>} */ const classes = {};
  const out = { turns: 0, titles: 0, names: 0, vectors: 0, classes };
  const note = (/** @type {string[]} */ cs) => { for (const c of cs) classes[c] = (classes[c] || 0) + 1; };
  const dv = db.prepare("DELETE FROM recall_vectors WHERE session = ? AND seq = ?");
  const updTurn = db.prepare("UPDATE recall_turns SET text = ? WHERE rowid = ?");
  const turns = db.prepare("SELECT rowid AS id, session, seq, text FROM recall_turns WHERE rowid > ? ORDER BY rowid LIMIT ?");
  let from = 0;
  for (;;) {
    const rows = /** @type {any[]} */ (turns.all(from, batch));
    if (!rows.length) break;
    db.exec("BEGIN");
    try {
      for (const r of rows) {
        const s = scrubText(r.text);
        if (!s.classes.length) continue;
        updTurn.run(s.text, r.id);
        out.vectors += Number(dv.run(r.session, r.seq).changes);
        out.turns++; note(s.classes);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    from = rows[rows.length - 1].id;
  }
  db.exec("BEGIN");
  try {
    for (const [col, key] of /** @type {const} */ ([["title", "titles"], ["name", "names"]])) {
      const upd = db.prepare(`UPDATE recall_sessions SET ${col} = ? WHERE id = ?`);
      for (const r of /** @type {any[]} */ (db.prepare(`SELECT id, ${col} AS v FROM recall_sessions WHERE ${col} IS NOT NULL`).all())) {
        const s = scrubText(r.v);
        if (!s.classes.length) continue;
        upd.run(s.text, r.id); out[key]++; note(s.classes);
      }
    }
    if (out.turns) db.prepare("INSERT INTO recall_meta (k, v) VALUES ('generation', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1").run();
    // The log row: when, how much and which classes. Never a value, never a position.
    const prev = /** @type {any} */ (db.prepare("SELECT v FROM recall_meta WHERE k = ?").get(LOG_KEY));
    /** @type {any[]} */ let log = [];
    try { log = prev ? JSON.parse(prev.v) : []; } catch { log = []; }
    log.push({ at: now(), turns: out.turns, titles: out.titles, names: out.names, vectors: out.vectors, classes });
    db.prepare("INSERT INTO recall_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(LOG_KEY, JSON.stringify(log.slice(-50)));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  // The FTS index keeps the old words in segments until it is merged: merge them out so the old text is not left behind in the index's own pages.
  if (out.turns) { try { db.exec("INSERT INTO recall_turns(recall_turns) VALUES ('optimize')"); } catch { /* an index with nothing to merge */ } }
  return out;
}

/** The scrub log, newest last: counts and classes only. @param {DB} db */
export function scrubLog(db) {
  const r = /** @type {any} */ (db.prepare("SELECT v FROM recall_meta WHERE k = ?").get(LOG_KEY));
  try { return r ? JSON.parse(r.v) : []; } catch { return []; }
}
