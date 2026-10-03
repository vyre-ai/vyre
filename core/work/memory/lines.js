// @ts-check
// Layer 3a: line-by-line session detail. A long session is kept exactly, line by line, so it can be recalled by address ("line:<session>#<seq>")
// and not only summarised. Lines are scrubbed on the way in (contract 7.9, 8.8) and carry the labels they arrived with. Erasure is by session.

import { scrub } from "./scrub.js";
import { joinLabels } from "../../../lib/labels.js";

/** @typedef {{ seq: number, role: string, text: string, at: number, labels: import("../../../lib/labels.js").Labels }} Line */

export const lineAddress = (/** @type {string} */ session, /** @type {number} */ seq) => `line:${session}#${seq}`;
/** @param {string} a @returns {{ session: string, seq: number }|null} */
export function parseLineAddress(a) {
  const m = /^line:(.+)#(\d+)$/.exec(a);
  return m ? { session: m[1], seq: Number(m[2]) } : null;
}

/** @param {any} db @param {import("./scrub.js").Redactor[]} redactors */
export function createLines(db, redactors) {
  const ins = db.prepare("INSERT OR REPLACE INTO memory_engine_lines (session, seq, role, text, at, trust, red, spaces, record) VALUES (?,?,?,?,?,?,?,?,?)");
  /** @param {any} r @returns {Line} */
  const row = r => ({ seq: Number(r.seq), role: String(r.role), text: String(r.text), at: Number(r.at), labels: { trust: r.trust, red: r.red, source_spaces: JSON.parse(r.spaces) } });
  return {
    /**
     * Keep a session's lines. `labels` are the labels of the content (a line read from mail is external). `record` is the resource a reader
     * must be allowed to read to see them (the session's thread record).
     * @param {string} session @param {{ seq: number, role: string, text: string, at?: number, labels?: import("../../../lib/labels.js").Labels }[]} lines
     * @param {{ labels: import("../../../lib/labels.js").Labels, record: string }} o @returns {number} lines kept
     */
    ingest(session, lines, { labels, record }) {
      let n = 0;
      db.exec("BEGIN");
      try {
        for (const l of lines) {
          const lab = joinLabels([labels, l.labels]);
          ins.run(session, l.seq, l.role, scrub(l.text, redactors).text, l.at ?? 0, lab.trust, lab.red, JSON.stringify(lab.source_spaces), record);
          n++;
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      return n;
    },
    /** The exact lines from `from` to `to` inclusive. @param {string} session @param {number} from @param {number} to @returns {Line[]} */
    recall(session, from, to) {
      return db.prepare("SELECT * FROM memory_engine_lines WHERE session = ? AND seq BETWEEN ? AND ? ORDER BY seq").all(session, from, to).map(row);
    },
    /** A window of lines around the first line matching `query` (or around `seq`). @param {{ session: string, query?: string, seq?: number, radius?: number }} q */
    window({ session, query, seq, radius = 3 }) {
      let at = seq;
      if (at === undefined && query) {
        const hit = db.prepare("SELECT seq FROM memory_engine_lines WHERE session = ? AND text LIKE ? ORDER BY seq LIMIT 1").get(session, `%${String(query).replace(/[%_]/g, "")}%`);
        at = hit ? Number(hit.seq) : undefined;
      }
      if (at === undefined) return [];
      return this.recall(session, at - radius, at + radius);
    },
    /** @param {string} session @returns {{ record: string }|null} */
    meta(session) { const r = db.prepare("SELECT record FROM memory_engine_lines WHERE session = ? LIMIT 1").get(session); return r ? { record: String(r.record) } : null; },
    all(/** @type {string} */ session) { return db.prepare("SELECT * FROM memory_engine_lines WHERE session = ? ORDER BY seq").all(session).map(r => ({ ...row(r), record: String(r.record) })); },
    /** Erase a session's detail. @param {string} session */
    forget(session) { return Number(db.prepare("DELETE FROM memory_engine_lines WHERE session = ?").run(session).changes); },
  };
}
