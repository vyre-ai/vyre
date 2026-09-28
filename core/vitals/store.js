// @ts-check
// store: the rollups (docs/design/vitals.md). One row per minute for 24 h, folded into one row
// per hour for 30 days, both pruned. The average and peak for a minute are worked out in memory
// from whatever samples that minute saw (one, at idle cadence; up to thirty, while watched) and
// written once, so a watched minute costs the same one write idle costs — never one write every
// 2 s.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3600_000;
const KEEP_HOURS_DAYS = 30;

export const MIGRATIONS = [`
  CREATE TABLE vitals_minute (
    minute TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
    cpu REAL, cpuMax REAL, ram REAL, ramMax REAL, gpu REAL, disk REAL,
    netRx REAL, netTx REAL, battery REAL,
    PRIMARY KEY (minute, device, scope)
  );
  CREATE INDEX vitals_minute_device ON vitals_minute(device, scope, minute);
  CREATE TABLE vitals_hour (
    hour TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
    cpu REAL, cpuMax REAL, ram REAL, ramMax REAL, gpu REAL, disk REAL,
    netRx REAL, netTx REAL, battery REAL,
    PRIMARY KEY (hour, device, scope)
  );
  CREATE INDEX vitals_hour_device ON vitals_hour(device, scope, hour);
`];

/** UTC "YYYY-MM-DDTHH:MM". @param {number} at */
export const minuteKey = at => new Date(at).toISOString().slice(0, 16);
/** UTC "YYYY-MM-DDTHH". @param {number} at */
export const hourKey = at => new Date(at).toISOString().slice(0, 13);

/**
 * The mean and the peak of a metric across this minute's fast samples, ignoring null readings
 * (a metric this platform cannot read yet stays null throughout, never a false 0).
 * @param {Array<number|null>} values
 */
export function fold(values) {
  const v = values.filter(x => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return { mean: null, max: null };
  return { mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10, max: Math.max(...v) };
}

const COLS = ["cpu", "cpuMax", "ram", "ramMax", "gpu", "disk", "netRx", "netTx", "battery"];

export class Store {
  /** @param {import("node:sqlite").DatabaseSync} db @param {() => number} now */
  constructor(db, now) {
    this.db = db;
    this.now = now;
    this.upsertMinute = db.prepare(`INSERT INTO vitals_minute (minute, device, scope, ${COLS.join(", ")})
      VALUES (?, ?, ?, ${COLS.map(() => "?").join(", ")})
      ON CONFLICT (minute, device, scope) DO UPDATE SET ${COLS.map(c => `${c} = excluded.${c}`).join(", ")}`);
  }

  /**
   * One minute's folded row, from the in-memory samples the caller collected. `cpu`/`ram` are
   * the minute's mean; `cpuMax`/`ramMax` the minute's peak; every other metric is one number (no
   * averaging: disk barely moves in a minute, and net/gpu/battery are read once regardless of
   * cadence today).
   * @param {{ minute: string, device: string, scope?: string, cpu: number|null, cpuMax: number|null,
   *   ram: number|null, ramMax: number|null, gpu: number|null, disk: number|null,
   *   netRx: number|null, netTx: number|null, battery: number|null }} row
   */
  record(row) {
    this.upsertMinute.run(row.minute, row.device, row.scope || "", ...COLS.map(c => row[c] ?? null));
  }

  /** Every device/scope pair with a minute row in `[from, to)` (both minute keys, `to` exclusive). */
  pairsSince(from, to) {
    return /** @type {any[]} */ (this.db.prepare(
      "SELECT DISTINCT device, scope FROM vitals_minute WHERE minute >= ? AND minute < ?").all(from, to))
      .map(r => ({ device: String(r.device), scope: String(r.scope) }));
  }

  /** Folds every minute row in one hour into one vitals_hour row, per device/scope pair seen. */
  rollupHour(hour) {
    const from = hour + ":00", to = hour + ":60"; // ":60" sorts after every real minute ("00".."59")
    for (const { device, scope } of this.pairsSince(from, to)) {
      const rows = /** @type {any[]} */ (this.db.prepare(
        "SELECT * FROM vitals_minute WHERE device = ? AND scope = ? AND minute >= ? AND minute < ?").all(device, scope, from, to));
      /** @type {Record<string, number|null>} */
      const out = {};
      for (const c of COLS) {
        const vals = rows.map(r => r[c]).filter(v => typeof v === "number" && Number.isFinite(v));
        out[c] = vals.length ? (c === "cpuMax" || c === "ramMax" ? Math.max(...vals) : Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10) : null;
      }
      this.db.prepare(`INSERT INTO vitals_hour (hour, device, scope, ${COLS.join(", ")})
        VALUES (?, ?, ?, ${COLS.map(() => "?").join(", ")})
        ON CONFLICT (hour, device, scope) DO UPDATE SET ${COLS.map(c => `${c} = excluded.${c}`).join(", ")}`)
        .run(hour, device, scope, ...COLS.map(c => out[c]));
    }
  }

  /** Minute rows older than 24 h, hour rows older than 30 days. */
  prune() {
    this.db.prepare("DELETE FROM vitals_minute WHERE minute < ?").run(minuteKey(this.now() - DAY_MS));
    this.db.prepare("DELETE FROM vitals_hour WHERE hour < ?").run(hourKey(this.now() - KEEP_HOURS_DAYS * DAY_MS));
  }

  /** The most recent minute row for one device/scope, or null. */
  latest(device, scope = "") {
    return /** @type {any} */ (this.db.prepare(
      "SELECT * FROM vitals_minute WHERE device = ? AND scope = ? ORDER BY minute DESC LIMIT 1").get(device, scope)) || null;
  }

  /** Minute rows for one device/scope since `sinceMs`, oldest first (a sparkline's data). */
  history(device, scope, sinceMs) {
    return /** @type {any[]} */ (this.db.prepare(
      "SELECT * FROM vitals_minute WHERE device = ? AND scope = ? AND minute >= ? ORDER BY minute").all(device, scope, minuteKey(sinceMs)));
  }

  /**
   * How many of the last `days` days' hourly rollups had this metric's peak at or over
   * `thresholdPct` (vitals.advice's "RAM hit 90% four times this week" style rule).
   */
  breaches(device, scope, metric, thresholdPct, days) {
    const col = metric === "cpu" ? "cpuMax" : metric === "ram" ? "ramMax" : metric;
    const rows = /** @type {any[]} */ (this.db.prepare(
      `SELECT ${col} AS v FROM vitals_hour WHERE device = ? AND scope = ? AND hour >= ?`).all(device, scope, hourKey(this.now() - days * DAY_MS)));
    return rows.filter(r => typeof r.v === "number" && r.v >= thresholdPct).length;
  }
}

export { MINUTE_MS };
