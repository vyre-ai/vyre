// @ts-check
// The rate-limit line said in a thread. Claude names each window (the five-hour window, the
// overall weekly window, the Opus weekly window) and each window has its own utilization.
// The top-level number is not borrowed for a window that names its own. The reset is the
// person's own time, from the zone the thread kept.

import { localParts, validZone } from "../../lib/time/zones.js";

/** A rate-limit warning is said in the thread from this much of the limit used. */
export const LIMIT_NOTICE_AT = 0.8;

const WINDOW_NAME = {
  five_hour: "five-hour",
  seven_day: "overall weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  seven_day_oauth_apps: "weekly apps",
  seven_day_overage_included: "weekly included",
  overage: "extra usage",
};
const NESTED = /^(?:five_hour|seven_day|overage)(?:_|$)/;
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {any} o */
function numUtil(o) {
  if (!o || typeof o !== "object") return null;
  if (typeof o.utilization === "number") return o.utilization;
  if (typeof o.used_percentage === "number") return o.used_percentage > 1 ? o.used_percentage / 100 : o.used_percentage;
  return null;
}
/** @param {any} o */
function numReset(o) {
  if (!o || typeof o !== "object") return null;
  const n = o.resets_at ?? o.resetsAt;
  return typeof n === "number" ? n : null;
}

/**
 * One entry per window Claude reported, each with its own utilization. A nested object for the
 * named window wins over the top-level number, which can be a different window's.
 * @param {any} info rate_limit_info
 * @returns {{ kind: string, status: string, resets_at?: number, utilization?: number }[]}
 */
export function windowsOf(info) {
  const r = info && typeof info === "object" ? info : {};
  /** @type {Map<string, any>} */
  const bag = new Map();
  const take = (/** @type {string} */ kind, /** @type {any} */ src) => {
    if (!kind || bag.has(kind) || !src || typeof src !== "object") return;
    bag.set(kind, src);
  };
  for (const k of Object.keys(r)) {
    if (NESTED.test(k) && r[k] && typeof r[k] === "object") take(k, r[k]);
  }
  const extra = r.windows;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const k of Object.keys(extra)) take(k, extra[k]);
  }
  const named = typeof r.rateLimitType === "string" ? r.rateLimitType : "";
  if (named && !bag.has(named)) take(named, { utilization: r.utilization, resetsAt: r.resetsAt ?? r.resets_at, status: r.status });
  const out = [];
  for (const [kind, src] of bag) {
    const status = typeof src.status === "string" ? src.status : (kind === named && typeof r.status === "string" ? r.status : "allowed");
    const utilization = numUtil(src);
    const resets_at = numReset(src);
    out.push({ kind, status, ...(resets_at != null ? { resets_at } : {}), ...(utilization != null ? { utilization } : {}) });
  }
  return out;
}

/**
 * The limit the switchboard keeps and emits. The top-level kind is the window Claude named
 * (rateLimitType), with that window's own utilization. `windows` is set only when the event
 * carried more than one, so a single-window event stays the shape it always had.
 * @param {any} info
 */
export function limitFrom(info) {
  const r = info && typeof info === "object" ? info : {};
  const windows = windowsOf(r);
  const named = typeof r.rateLimitType === "string" ? r.rateLimitType : null;
  const primary = (named && windows.find(w => w.kind === named)) || windows[0] || null;
  const resets = primary && typeof primary.resets_at === "number" ? primary.resets_at : (typeof r.resetsAt === "number" ? r.resetsAt : null);
  const util = primary && typeof primary.utilization === "number" ? primary.utilization : (!windows.length && typeof r.utilization === "number" ? r.utilization : null);
  /** @type {any} */
  const limit = { status: String(r.status || (primary && primary.status) || "unknown"), kind: primary ? primary.kind : named, resets_at: resets };
  if (typeof util === "number") limit.utilization = util;
  if (windows.length > 1) limit.windows = windows;
  return limit;
}

/** True when a window is worth a line: refused, or at LIMIT_NOTICE_AT and above. @param {any} l */
export function limitLoud(l) {
  if (!l) return false;
  const rows = Array.isArray(l.windows) && l.windows.length ? l.windows : [l];
  return rows.some((/** @type {any} */ w) => w && (w.status === "rejected" || (typeof w.utilization === "number" && w.utilization >= LIMIT_NOTICE_AT)));
}

/** The person's zone on the thread: the zone of their last send, else the zone the run was started in. @param {any} row threads_runs tz and opts */
export function zoneOf(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.tz === "string" && validZone(row.tz)) return row.tz;
  let opts = {};
  try { opts = row.opts ? JSON.parse(String(row.opts)) : {}; } catch { opts = {}; }
  const z = /** @type {any} */ (opts).zone;
  return typeof z === "string" && validZone(z) ? z : null;
}

/** "Fri 24 Oct, 10:00" in the zone, or "" when there is no reset or no zone. @param {number | null | undefined} resetsAt @param {string | null} zone */
export function resetWhen(resetsAt, zone) {
  if (typeof resetsAt !== "number" || !zone || !validZone(zone)) return "";
  const ms = resetsAt >= 1e12 ? resetsAt : resetsAt * 1000;
  const p = localParts(ms, zone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `; it resets ${WEEK[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}, ${hh}:${mm}`;
}

/** @param {any} w @param {string | null} zone */
function lineOf(w, zone) {
  const known = w && w.kind ? /** @type {Record<string, string>} */ (WINDOW_NAME)[w.kind] : "";
  const which = w && w.kind ? (known || String(w.kind).replace(/_/g, "-")) + " " : "";
  const when = resetWhen(w && w.resets_at, zone);
  if (w && w.status === "rejected") return `Claude's ${which}usage limit is reached${when}.`;
  const pct = w && typeof w.utilization === "number" ? ` is at ${Math.round(w.utilization * 100)}%` : " is close";
  return `Claude's ${which}usage limit${pct}${when}.`;
}

/**
 * One sentence per window that is at the line or refused, each with that window's own
 * percentage and its own reset. Joined by a space.
 * @param {any} l @param {string | null} [zone]
 */
export function limitNotice(l, zone = null) {
  const rows = Array.isArray(l && l.windows) && l.windows.length ? l.windows : [l];
  const loud = rows.filter((/** @type {any} */ w) => w && (w.status === "rejected" || (typeof w.utilization === "number" && w.utilization >= LIMIT_NOTICE_AT)));
  const say = loud.length ? loud : rows.filter(Boolean);
  return say.map((/** @type {any} */ w) => lineOf(w, zone || null)).join(" ");
}
