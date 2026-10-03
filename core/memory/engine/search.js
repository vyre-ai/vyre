// @ts-check
// Layer 3b: the meaning index of one Space and the ranking over it. Rows hold scrubbed text from records, events and transcript lines, read through
// the gateway (so sealed fields are placeholders), each with the labels it was derived under and the resource a reader must be allowed to read.
// Ranking is by an injected embedder (cosine) when there is one, else a small lexical ranker, so the engine works with no model installed.

import { scrub } from "./scrub.js";

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "is", "was", "for", "in", "on", "at", "it", "that", "this", "with", "what", "who", "when", "did", "do", "does"]);
/** @param {string} s */
export const tokens = s => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9@.\s-]/g, " ").split(/\s+/).map(w => w.replace(/^[.-]+|[.-]+$/g, "")).filter(w => w.length > 1 && !STOP.has(w));

/** @param {number[]} a @param {number[]} b */
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };

/** @typedef {{ source: string, kind: "record"|"event"|"line", resource: string, text: string, labels: import("../../../lib/labels.js").Labels }} Row */

/** @param {any} db @param {{ embed?: (texts: string[]) => Promise<number[][]>, redactors?: import("./scrub.js").Redactor[] }} o */
export function createIndex(db, { embed, redactors = [] } = {}) {
  const up = db.prepare("INSERT OR REPLACE INTO memory_engine_index (source, kind, resource, text, vec, trust, red, spaces) VALUES (?,?,?,?,?,?,?,?)");
  /** @param {any} r @returns {Row} */
  const rowOf = r => ({ source: String(r.source), kind: r.kind, resource: String(r.resource), text: String(r.text), labels: { trust: r.trust, red: r.red, source_spaces: JSON.parse(r.spaces) } });
  return {
    /** Store one row. Text is scrubbed again here, so no caller can put a credential or a sealed-class shape in the index. @param {Row} r */
    async put(r) {
      const text = scrub(r.text, redactors).text;
      const vec = embed ? JSON.stringify((await embed([text]))[0] || null) : null;
      up.run(r.source, r.kind, r.resource, text, vec, r.labels.trust, r.labels.red, JSON.stringify(r.labels.source_spaces));
    },
    /** The `k` best rows for `text`, best first, with a score. @param {string} text @param {number} [k] @returns {Promise<(Row & { score: number })[]>} */
    async rank(text, k = 8) {
      const rows = db.prepare("SELECT * FROM memory_engine_index").all();
      const q = tokens(text);
      /** @type {(Row & { score: number })[]} */ const scored = [];
      const qv = embed ? (await embed([scrub(text, redactors).text]))[0] : null;
      const df = new Map();
      for (const r of rows) for (const w of new Set(tokens(r.text))) df.set(w, (df.get(w) || 0) + 1);
      for (const r of rows) {
        let score = 0;
        if (qv && r.vec) score = cosine(qv, JSON.parse(r.vec));
        else {
          const tf = new Map();
          for (const w of tokens(r.text)) tf.set(w, (tf.get(w) || 0) + 1);
          for (const w of q) if (tf.has(w)) score += (1 + Math.log(tf.get(w))) * Math.log(1 + rows.length / df.get(w));
          score /= 1 + Math.log(1 + tokens(r.text).length) / 4;
        }
        if (score > 0) scored.push({ ...rowOf(r), score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, k);
    },
    /** Delete every row derived from a resource or a source; returns the sources removed. @param {string} urn @returns {string[]} */
    forget(urn) {
      const gone = db.prepare("SELECT source FROM memory_engine_index WHERE source = ? OR resource = ?").all(urn, urn).map((/** @type {any} */ r) => String(r.source));
      db.prepare("DELETE FROM memory_engine_index WHERE source = ? OR resource = ?").run(urn, urn);
      return gone;
    },
    count() { return Number(db.prepare("SELECT count(*) AS n FROM memory_engine_index").get().n); },
    /** Everything stored, for the tests' canary sweep. */
    dump() { return db.prepare("SELECT source, text FROM memory_engine_index").all().map((/** @type {any} */ r) => `${r.source}\n${r.text}`).join("\n"); },
  };
}
