// @ts-check
// Sealed values never enter memory (0.3 minimum, CUTOVER section G, b). On the way in, free text a person typed, an agent wrote or a transcript held is scrubbed with the
// kernel's own sealed-class detectors (kernel/seal/classes.js: SSN, card, bank, IBAN, EIN and the rest, with spaces, dashes and spelled digits folded), so a value shaped like
// a sealed class is a placeholder in the row, never the value. `scanRows` is the one-time look at what memory already holds: it REPORTS (table, column, rows, classes) and
// changes nothing; a person decides what to do with it. It prints no value. What it cannot do is match a value that is sealed TODAY in some record by the sealing process's
// ledger (only the sealing process holds that); it finds what has the shape of a sealed class.
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
