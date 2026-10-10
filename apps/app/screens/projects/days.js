// @ts-check
// The days of a project's story (the timeline pane): one heading per day, read in the viewer's zone through lib/time like every other screen, never by the device's own date formatting.
import { dayOf, longDateOf, sameDay } from "../../src/time/show.js";

const DAY_MS = 86_400_000;

/** One key per day, so entries of the same day fall under one heading. @param {number} ms @param {string} [zone] */
export const dayKey = (ms, zone) => dayOf(ms, { zone });

/** "Today", "Yesterday", "Thursday, 1 October" (and the year when it is not this year); "Earlier" for an entry with no time. @param {number} ms @param {{ now?: number, zone?: string }} [o] */
export function dayLabel(ms, o = {}) {
  if (!ms) return "Earlier";
  const now = o.now ?? Date.now();
  if (sameDay(ms, now, o.zone)) return "Today";
  if (sameDay(ms, now - DAY_MS, o.zone)) return "Yesterday";
  const year = dayOf(ms, { zone: o.zone }).split(" ").pop();
  return year === dayOf(now, { zone: o.zone }).split(" ").pop() ? longDateOf(ms, o.zone) : `${longDateOf(ms, o.zone)} ${year}`;
}
