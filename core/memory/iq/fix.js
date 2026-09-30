// @ts-check
// iq/fix: the person corrects a Vyre IQ answer where it appears, and IQ remembers.
//
// Every answer memory.ask gives has an id (the same answer to the same question has the same id).
// memory.correct { answer: <id>, action } keeps a fix here:
//   replace { object }  the right answer, in the person's own words: the same question gets it at
//                       once, and the text is told to memory (memory.remember) for every other one;
//   wrong               that answer is wrong: the same question says so and abstains;
//   forget              the fact or the turns behind the answer never ground an answer again.
// A fix on a personal fact denies that fact (memory_me_denied), so personal/store.js derives it
// as no longer true. Every fix can be undone. The table is the person's local log: it lives in
// their vyred's database, and nothing here ever leaves the machine or enters an eval.

import crypto from "node:crypto";

/** The question as a key: lower case, words only, so "What's my wife's name?" matches "whats my wifes name". */
export const questionKey = (/** @type {string} */ q) => String(q || "").toLowerCase().replace(/['’`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** An answer's id: the question, the answer and what it stands on, so it is stable across asks. */
export const answerId = (/** @type {string} */ q, /** @type {string} */ answer, /** @type {string[]} */ refs) =>
  "a_" + crypto.createHash("sha256").update(`${questionKey(q)}\u0000${answer}\u0000${[...refs].sort().join(",")}`).digest("hex").slice(0, 16);

/** A rough kind of question, for "you corrected 3 answers this week" and which kinds IQ gets wrong. */
export function questionKind(q) {
  const s = questionKey(q);
  if (/\b(my|our) (wife|husband|partner|mother|mum|mom|father|dad|son|daughter|kid|kids|brother|sister|friend|dog|cat|pet)s?\b/.test(s)) return "people";
  if (/\bwho\b/.test(s)) return "who";
  if (/\b(when|date|day|deadline)\b/.test(s)) return "date";
  if (/\b(file|path|where is|which file)\b/.test(s)) return "file";
  if (/\b(decide|decided|decision|chose|choose|agreed)\b/.test(s)) return "decision";
  if (/\b(bug|error|broke|broken|crash|fix|fixed)\b/.test(s)) return "bug";
  if (/\b(deploy|deployed|release|shipped|port|config|setting|env)\b/.test(s)) return "config";
  if (/\b(my|i)\b/.test(s)) return "personal";
  return "other";
}

const DAY = 86_400_000;

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, now?: () => number }} deps
 */
export function fixes({ db, now = () => Date.now() }) {
  const q = {
    issue: db.prepare(`INSERT INTO memory_iq_answers (id, at, question, answer, via, facts, turns) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET at = excluded.at`),
    answer: db.prepare("SELECT * FROM memory_iq_answers WHERE id = ?"),
    prune: db.prepare("DELETE FROM memory_iq_answers WHERE at < ? AND id NOT IN (SELECT answer FROM memory_iq_fixes)"),
    add: db.prepare(`INSERT INTO memory_iq_fixes (at, answer, qkey, question, kind, action, old, text, facts, turns, who) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    told: db.prepare("UPDATE memory_iq_fixes SET told = ? WHERE id = ?"),
    byKey: db.prepare("SELECT * FROM memory_iq_fixes WHERE qkey = ? AND undone IS NULL AND action IN ('replace', 'wrong') ORDER BY id DESC LIMIT 1"),
    forgotten: db.prepare("SELECT turns FROM memory_iq_fixes WHERE undone IS NULL AND action = 'forget'"),
    get: db.prepare("SELECT * FROM memory_iq_fixes WHERE id = ?"),
    undo: db.prepare("UPDATE memory_iq_fixes SET undone = ? WHERE id = ? AND undone IS NULL"),
    list: db.prepare("SELECT * FROM memory_iq_fixes WHERE (? OR undone IS NULL) ORDER BY id DESC LIMIT ?"),
    since: db.prepare("SELECT kind, COUNT(*) AS n FROM memory_iq_fixes WHERE at >= ? AND undone IS NULL GROUP BY kind"),
    deny: db.prepare("INSERT OR REPLACE INTO memory_me_denied (fact, fix) VALUES (?, ?)"),
    undeny: db.prepare("DELETE FROM memory_me_denied WHERE fix = ?"),
  };
  let lastPrune = 0;
  const row = r => r && ({ id: Number(r.id), at: Number(r.at), answer: String(r.answer), question: String(r.question), kind: String(r.kind), action: String(r.action),
    old: String(r.old), text: r.text == null ? null : String(r.text), told: r.told == null ? null : Number(r.told), facts: JSON.parse(String(r.facts || "[]")), turns: JSON.parse(String(r.turns || "[]")), undone: r.undone == null ? null : Number(r.undone) });

  return {
    /**
     * Keep an answer so the person can correct it by its id; answers nobody corrected go after 30 days.
     * @param {{ question: string, answer: string, via: string|null, facts?: string[], sources?: { session: string, seq: number }[] }} a
     */
    issue(a) {
      const turns = (a.sources || []).map(s => `${s.session}:${s.seq}`);
      const facts = a.facts || [];
      const id = answerId(a.question, a.answer, [...facts, ...turns]);
      const t = now();
      q.issue.run(id, t, a.question, a.answer, a.via || null, JSON.stringify(facts), JSON.stringify(turns));
      if (t - lastPrune > DAY) { lastPrune = t; q.prune.run(t - 30 * DAY); }
      return id;
    },
    answer(id) { const r = /** @type {any} */ (q.answer.get(String(id))); return r ? { ...r, facts: JSON.parse(r.facts || "[]"), turns: JSON.parse(r.turns || "[]") } : null; },
    /**
     * @param {{ answer: string, action: "replace"|"wrong"|"forget", text?: string|null, who?: string|null }} f
     */
    add(f) {
      const a = this.answer(f.answer);
      if (!a) throw Object.assign(new Error(`no answer ${f.answer}: it may be older than 30 days; ask again and correct that one`), { code: "not_found" });
      const text = f.action === "replace" ? String(f.text || "").replace(/\s+/g, " ").trim().slice(0, 500) : null;
      if (f.action === "replace" && !text) throw Object.assign(new Error("replace needs the right answer in object"), { code: "bad_input" });
      const id = Number(q.add.run(now(), a.id, questionKey(a.question), a.question, questionKind(a.question), f.action, a.answer, text,
        JSON.stringify(a.facts), JSON.stringify(a.turns), f.who || null).lastInsertRowid);
      for (const fact of a.facts) q.deny.run(fact, id);
      return row(q.get.get(id));
    },
    /** The told note (memory.remember) a fix made, so undoing the fix removes it too. */
    told(id, told) { q.told.run(Number(told), Number(id)); },
    /** The fix that answers this question, if the person made one. */
    lookup(question) { return row(q.byKey.get(questionKey(question))) || null; },
    /** Turns the person said to forget: they never ground an answer again. */
    forgotten() { const out = new Set(); for (const r of /** @type {any[]} */ (q.forgotten.all())) for (const t of JSON.parse(String(r.turns || "[]"))) out.add(String(t)); return out; },
    undo(id) {
      const had = row(q.get.get(Number(id)));
      if (!had) throw Object.assign(new Error(`no answer correction ${id}`), { code: "not_found" });
      q.undo.run(now(), Number(id));
      q.undeny.run(Number(id));
      return row(q.get.get(Number(id)));
    },
    list({ all = false, limit = 50 } = {}) { return /** @type {any[]} */ (q.list.all(all ? 1 : 0, Math.max(1, Math.min(500, limit)))).map(row); },
    /** How many answers the person corrected in the last 7 days, by kind of question. */
    week() {
      const by = Object.fromEntries(/** @type {any[]} */ (q.since.all(now() - 7 * DAY)).map(r => [String(r.kind), Number(r.n)]));
      return { corrected: Object.values(by).reduce((a, b) => a + b, 0), by_kind: by };
    },
  };
}
