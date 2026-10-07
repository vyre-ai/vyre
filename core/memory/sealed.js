// @ts-check
// Sealed values never enter memory (0.3 minimum, CUTOVER section G, b). On the way in, free text a person typed, an agent wrote or a transcript held is scrubbed with the
// kernel's own sealed-class detectors (kernel/seal/classes.js: SSN, card, bank, IBAN, EIN and the rest, with spaces, dashes and spelled digits folded), so a value shaped like
// a sealed class is a placeholder in the row, never the value. `scanRows` is the one-time look at what memory already holds: it REPORTS (table, column, rows, classes) and
// changes nothing; a person decides what to do with it. It prints no value. What it cannot do is match a value that is sealed TODAY in some record by the sealing process's
// ledger (only the sealing process holds that); it finds what has the shape of a sealed class.
import { createHash } from "node:crypto";
import { detect, redact } from "../../kernel/seal/classes.js";

/** @param {unknown} text @returns {{ text: string, classes: string[] }} */
export function scrubIn(text) {
  const t = String(text ?? "");
  if (!detect(t).length) return { text: t, classes: [] };
  const r = redact(t);
  return { text: r.text, classes: [...new Set(r.found.map(f => f.class))] };
}
/** @param {unknown} text */
export const scrubbed = text => scrubIn(text).text;

/** Every free-text column memory keeps from a person, an agent or a transcript. */
export const TEXT_COLUMNS = Object.freeze([
  ["memory_writes", "text"], ["memory_me_told", "text"], ["memory_me_claims", "obj"], ["memory_me_cues", "text"], ["memory_me_facts", "obj_label"],
  ["memory_decisions", "statement"], ["memory_decisions", "value"], ["memory_decisions", "display"], ["memory_corrections", "note"], ["memory_corrections", "object"],
  ["memory_taught", "fact"],
]);

/**
 * What memory already holds that has the shape of a sealed value. Counts only, never a value. @param {any} db
 * @returns {{ table: string, column: string, rows: number, classes: Record<string, number> }[]}
 */
export function scanRows(db) {
  const out = [];
  for (const [table, column] of TEXT_COLUMNS) {
    let rows;
    try { rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all(); } catch { continue; } // a table this install does not have
    /** @type {Record<string, number>} */ const classes = {};
    let n = 0;
    for (const r of rows) { const { classes: cs } = scrubIn(r.v); if (cs.length) { n++; for (const c of cs) classes[c] = (classes[c] || 0) + 1; } }
    if (n) out.push({ table, column, rows: n, classes });
  }
  return out;
}

// The ledger match (SD-3). The shape scan above cannot see a value that is sealed in a record today but has no class shape (a case number, a member id). The sealing process can
// answer, for ONE candidate, whether it equals a sealed field's current value the person may read (`ctx.kernel.sealDetect`, yes or no, rate limited per module and Space), so the
// scan offers it candidate tokens a few at a time, counts the rows that held a hit (never the value, never a hash of it) and says how much is left. Nothing is changed.

/** Candidate values worth a ledger call: 6 to 64 characters, at least one digit, not already class-shaped, not an id, url, path, time or hash. @param {unknown} text @returns {string[]} */
export function candidates(text) {
  const t = String(text ?? "");
  if (t.length < 6) return [];
  const out = new Set();
  for (const raw of t.split(/[\s,;:()[\]{}"'<>|=]+/)) {
    const w = raw.replace(/^[.\-_/#]+|[.\-_/#]+$/g, "");
    const n = w.replace(/[\s-]/g, "");
    if (n.length < 6 || w.length > 64 || !/\d/.test(w)) continue;
    if (/^(?:https?:|vyre:|file:|\/|~)/.test(w) || /\//.test(w)) continue;      // links, urns, paths
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(w) || /^[0-9a-f]{24,}$/i.test(w)) continue; // uuids, hashes
    if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(w) || /^\d{1,2}[:.]\d{2}/.test(w)) continue; // dates and times
    if (/^(?:per|spc|rec|tsk|sess|msg)_/i.test(w)) continue;                      // our own ids
    out.add(w);
  }
  return [...out];
}

/**
 * Offer the held free text to the ledger, one candidate per call, at most `max` calls. Resolves counts only: the rows (table, column, how many) that held a candidate the ledger
 * said is sealed, how many calls were made, and why it stopped. A `rate_limited` answer stops the pass cleanly; the next run goes on, because answered "no" candidates are skipped.
 * @param {any} db @param {(value: string) => Promise<boolean>} match @param {{ max?: number, rows?: number }} [o]
 */
export async function ledgerScan(db, match, o = {}) {
  const max = Math.max(1, Math.min(Number(o.max) || 5, 100)), rowCap = Math.max(1, Math.min(Number(o.rows) || 5000, 20000));
  db.exec("CREATE TABLE IF NOT EXISTS memory_sealscan_no (h TEXT PRIMARY KEY, at INTEGER NOT NULL DEFAULT 0)");
  // A "no" holds for a week: a value sealed after that is asked again.
  const now = Date.now(), week = 7 * 86_400_000;
  const no = db.prepare("SELECT 1 FROM memory_sealscan_no WHERE h = ? AND at > ?"), addNo = db.prepare("INSERT OR REPLACE INTO memory_sealscan_no (h, at) VALUES (?, ?)");
  const key = (/** @type {string} */ v) => createHash("sha256").update("memory-sealscan\0" + v.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
  let calls = 0, left = 0, stopped = null;
  /** @type {Map<string, boolean>} */ const asked = new Map();
  /** @type {Map<string, number>} */ const hitRows = new Map();
  scan: for (const [table, column] of TEXT_COLUMNS) {
    let rows;
    try { rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL LIMIT ${rowCap}`).all(); } catch { continue; }
    for (const r of rows) {
      let held = false;
      for (const c of candidates(r.v)) {
        const k = key(c);
        if (no.get(k, now - week)) continue;
        let yes = asked.get(k);
        if (yes === undefined) {
          if (calls >= max) { left++; continue; }
          try { yes = await match(c); } catch (e) {
            const code = /** @type {any} */ (e)?.code;
            if (code === "rate_limited") { stopped = "rate_limited"; left++; break scan; }
            if (code === "first_party_only" || code === "human_only" || code === "unavailable") { stopped = code; break scan; }
            continue; // a candidate the process refuses (too short once compacted) is skipped
          }
          calls++; asked.set(k, yes);
          if (!yes) addNo.run(k, now);
        }
        if (yes) held = true;
      }
      if (held) hitRows.set(`${table}\0${column}`, (hitRows.get(`${table}\0${column}`) || 0) + 1);
    }
  }
  const hits = [...hitRows].map(([k, rows]) => { const [table, column] = k.split("\0"); return { table, column, rows }; });
  return { calls, matched: hits, remaining: left, stopped: stopped || (left ? "max" : null) };
}
