// @ts-check
// metrics: does a lesson work? (ADR 0007, decision 9)
//
// Per day Learning counts the turns in each project and for each agent (learn_days), and per
// lesson how often it applied, caught Claude, was broken, and was repeated: the user correcting
// the same thing again, a signal with the lesson's key (learn_lesson_days). Nothing is computed
// on a timer; the verdict is worked out when someone asks.
//
//   before  repeats per 100 turns in scope, from the first signal to acceptance
//   after   escapes (broken + repeats) per 100 turns in scope since acceptance
//   working      after is at most half of before, with 50 turns measured
//   not working  after is at least before, with 50 turns measured
//   measuring    anything else
//
// Days are UTC days, so the acceptance day counts on the "after" side; the first and the
// acceptance on one day measure that day's turns as "before".
//
// Nothing weakens on its own: a lesson quiet for 60 days and 200 turns in scope goes dormant
// (out of the brief, its check still running), and wakes the moment it catches or breaks.

import { dayOf } from "./signals.js";

export const METRICS_MIGRATION = `CREATE TABLE learn_days (
     day TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', turns INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, project, agent)
   );
   CREATE TABLE learn_lesson_days (
     lesson INTEGER NOT NULL, day TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, caught INTEGER NOT NULL DEFAULT 0,
     broken INTEGER NOT NULL DEFAULT 0, repeats INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (lesson, day)
   );`;

export const MEASURED = 50;
export const DORMANT_DAYS = 60, DORMANT_TURNS = 200;
const DAY = 86_400_000;

/**
 * @param {import("node:sqlite").DatabaseSync} db @param {() => number} now
 */
export function createMetrics(db, now) {
  const upTurn = db.prepare(`INSERT INTO learn_days (day, project, agent, turns) VALUES (?,?,?,1)
    ON CONFLICT (day, project, agent) DO UPDATE SET turns = turns + 1`);
  const upLesson = db.prepare(`INSERT INTO learn_lesson_days (lesson, day, applied, caught, broken, repeats) VALUES (?,?,?,?,?,?)
    ON CONFLICT (lesson, day) DO UPDATE SET applied = applied + excluded.applied, caught = caught + excluded.caught,
      broken = broken + excluded.broken, repeats = repeats + excluded.repeats`);

  /** Turns in a lesson's scope on the days from `from` to `to` (YYYY-MM-DD, inclusive). */
  const turnsIn = (scope, from, to) => {
    const where = scope && typeof scope === "object" && scope.project ? "AND project = ?" : scope && typeof scope === "object" && scope.agent ? "AND agent = ?" : "";
    const args = scope && typeof scope === "object" ? [scope.project || scope.agent].filter(Boolean) : [];
    return Number(/** @type {any} */ (db.prepare(`SELECT COALESCE(SUM(turns), 0) AS n FROM learn_days WHERE day >= ? AND day <= ? ${where}`).get(from, to, ...args)).n);
  };
  const sums = (lesson, from, to) => /** @type {any} */ (db.prepare(`SELECT COALESCE(SUM(applied),0) AS applied, COALESCE(SUM(caught),0) AS caught,
      COALESCE(SUM(broken),0) AS broken, COALESCE(SUM(repeats),0) AS repeats FROM learn_lesson_days WHERE lesson = ? AND day >= ? AND day <= ?`).get(lesson, from, to));
  const repeatsBetween = (key, from, to) => key
    ? Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM learn_signals WHERE key = ? AND kind = 'prompt' AND at >= ? AND at < ?").get(key, from, to)).n) : 0;
  const rate = (n, turns) => Math.round((n * 100 / Math.max(1, turns)) * 100) / 100;

  return {
    /** One prompt: a turn in this project and for this agent. */
    turn({ project, agent }) { upTurn.run(dayOf(now()), project || "", agent || ""); },

    /** A lesson's counts today. */
    tally(lesson, { applied = 0, caught = 0, broken = 0, repeats = 0 }) {
      if (applied || caught || broken || repeats) upLesson.run(lesson, dayOf(now()), applied, caught, broken, repeats);
    },

    /**
     * The effect of one lesson.
     * @param {{ id: number, scope: any, key?: string|null, status: string, accepted?: number|null, created: number }} l
     * @returns {{ before: number|null, after: number|null, escapes: number, attempts: number, turns: number, verdict: "working"|"not working"|"measuring" }}
     */
    stats(l) {
      const today = dayOf(now());
      const all = sums(l.id, "0000-00-00", "9999-99-99");
      if (l.status !== "active" || !l.accepted) return { before: null, after: null, escapes: 0, attempts: Number(all.caught), turns: 0, verdict: "measuring" };
      const first = l.key ? /** @type {any} */ (db.prepare("SELECT MIN(at) AS at FROM learn_signals WHERE key = ?").get(l.key)).at : null;
      const start = Math.min(first == null ? l.created : Number(first), l.created, l.accepted);
      const acceptDay = dayOf(l.accepted), startDay = dayOf(start);
      const beforeTo = startDay === acceptDay ? acceptDay : dayOf(l.accepted - DAY);
      const beforeTurns = turnsIn(l.scope, startDay, beforeTo);
      const before = rate(repeatsBetween(l.key, start, l.accepted), beforeTurns);
      const turns = turnsIn(l.scope, acceptDay, today);
      const escapes = Number(all.broken) + repeatsBetween(l.key, l.accepted, now() + 1);
      const after = rate(escapes, turns);
      const verdict = turns < MEASURED ? "measuring" : after <= before / 2 ? "working" : after >= before ? "not working" : "measuring";
      return { before, after, escapes, attempts: Number(all.caught), turns, verdict };
    },

    /**
     * Should this active lesson go dormant? Accepted 60 days ago or more, 200 turns in scope in
     * the last 60 days, and in them nothing caught, broken or repeated.
     */
    quiet(l) {
      if (!l.accepted || now() - l.accepted < DORMANT_DAYS * DAY) return false;
      const from = dayOf(now() - DORMANT_DAYS * DAY), to = dayOf(now());
      if (turnsIn(l.scope, from, to) < DORMANT_TURNS) return false;
      const s = sums(l.id, from, to);
      return !Number(s.caught) && !Number(s.broken) && !Number(s.repeats);
    },

    /** Days older than a year are forgotten. */
    prune() {
      const cut = dayOf(now() - 366 * DAY);
      db.prepare("DELETE FROM learn_days WHERE day < ?").run(cut);
      db.prepare("DELETE FROM learn_lesson_days WHERE day < ?").run(cut);
    },
  };
}
