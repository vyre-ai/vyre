// @ts-check
// The pure half of DateTimeField: a moment as two parts a person edits (a day and a time of day, in a zone), and the two parts back into the moment. A time the clocks skip moves forward as a phone does and one
// that happens twice takes the first (lib/time toUTC), so a Flow that waits until 02:30 on the spring-forward night still runs.
import { localParts, parseDate, parseWall, toUTC, dateString, wallString } from "../../../../lib/time/index.js";

/** @param {string | number | null | undefined} value an ISO instant (or ms) @param {string} zone @returns {{ date: string, time: string }} */
export function partsOf(value, zone) {
  if (value === null || value === undefined || value === "") return { date: "", time: "" };
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  const p = localParts(ms, zone);
  return { date: dateString(p), time: wallString(p) };
}

/**
 * The moment the two parts name, as an ISO instant (a day alone, for `dateOnly`, as YYYY-MM-DD), or null while either part is not a real value. An empty time reads as `defaultTime`.
 * @param {string} date @param {string} time @param {string} zone @param {{ dateOnly?: boolean, defaultTime?: string }} [o]
 */
export function joinParts(date, time, zone, o = {}) {
  const d = parseDate(String(date).trim());
  if (!d) return null;
  if (o.dateOnly) return dateString(d);
  const w = parseWall(String(time).trim() || o.defaultTime || "09:00");
  if (!w) return null;
  return new Date(toUTC(d, w, zone)).toISOString();
}

/** What is wrong with the parts, in words, or "" (nothing typed is not wrong). @param {string} date @param {string} time */
export function partsProblem(date, time) {
  if (date.trim() && !parseDate(date.trim())) return "Use a date like 2026-10-28.";
  if (time.trim() && !parseWall(time.trim())) return "Use a time like 14:30.";
  return "";
}
