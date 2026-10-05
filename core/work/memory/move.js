// @ts-check
// The Work engine's session lines move with a project (team/0.3/DESIGN-project-move.md): the lines whose `record` is the project's record or one of its moved records go to the target Space with
// `record` rewritten through the move's id map and the source Space replaced by the target in their labels. Only the lines move: the index, suggestions and proposals are derived, so the
// source drops them with the lines and the target's engine indexes what arrives. Export reads, import is one transaction and idempotent (a repeat gives the same receipt), forget needs the receipt
// and refuses if the lines changed since export, so nothing is dropped unseen.
import crypto from "node:crypto";

const canon = (/** @type {any} */ v) => JSON.stringify(v);
/** @param {any[]} rows */
const digestOf = rows => crypto.createHash("sha256").update(canon(rows)).digest("base64url");

/** @param {any} db @param {string[]} records @returns {any[]} */
function linesOf(db, records) {
  if (!records.length) return [];
  const q = `SELECT session, seq, role, text, at, trust, red, spaces, record FROM memory_engine_lines WHERE record IN (${records.map(() => "?").join(",")}) ORDER BY session, seq`;
  return db.prepare(q).all(...records).map((/** @type {any} */ r) => ({ session: String(r.session), seq: Number(r.seq), role: String(r.role), text: String(r.text), at: Number(r.at), trust: String(r.trust), red: String(r.red), spaces: String(r.spaces), record: String(r.record) }));
}

/** @param {any} db @param {{ records: string[] }} o @returns {{ rows: any[], digest: string, count: number }} */
export function exportKnow(db, { records }) {
  const rows = linesOf(db, records);
  return { rows, digest: digestOf(rows), count: rows.length };
}

/**
 * @param {any} db @param {any[]} rows @param {{ map: Record<string, string>, from: string, to: string }} o
 * @returns {{ digest: string, count: number, sessions: string[] }}
 */
export function importKnow(db, rows, { map, from, to }) {
  const ins = db.prepare("INSERT OR REPLACE INTO memory_engine_lines (session, seq, role, text, at, trust, red, spaces, record) VALUES (?,?,?,?,?,?,?,?,?)");
  const moved = rows.map(r => {
    const record = map[r.record];
    if (!record) throw Object.assign(new Error(`a line names a record that did not move (${r.record})`), { code: "bad_input" });
    let spaces = [];
    try { spaces = JSON.parse(r.spaces); } catch { spaces = []; }
    return { ...r, record, spaces: JSON.stringify([...new Set((Array.isArray(spaces) ? spaces : []).map((/** @type {string} */ s) => (s === from ? to : s)))]) };
  });
  db.exec("BEGIN");
  try { for (const r of moved) ins.run(r.session, r.seq, r.role, r.text, r.at, r.trust, r.red, r.spaces, r.record); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { digest: digestOf(rows), count: rows.length, sessions: [...new Set(moved.map(r => r.session))] };
}

/** @param {any} db @param {{ records: string[], receipt: { digest: string, count: number } }} o @returns {{ forgotten: number }} */
export function forgetKnow(db, { records, receipt }) {
  const now = linesOf(db, records);
  if (!receipt || receipt.digest !== digestOf(now)) throw Object.assign(new Error("the Space's memory of this project changed since it was exported; export it again"), { code: "conflict" });
  db.exec("BEGIN");
  try {
    const ph = records.map(() => "?").join(",");
    if (records.length) {
      db.prepare(`DELETE FROM memory_engine_index WHERE resource IN (${ph})`).run(...records);
      db.prepare(`DELETE FROM memory_engine_suggestions WHERE record IN (${ph})`).run(...records);
      db.prepare(`DELETE FROM memory_engine_proposals WHERE record IN (${ph})`).run(...records);
      db.prepare(`DELETE FROM memory_engine_lines WHERE record IN (${ph})`).run(...records);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { forgotten: now.length };
}
