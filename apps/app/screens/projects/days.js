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

/** Entries (newest first) under one heading per day, in the viewer's zone. @template {{ at: number }} T @param {T[]} rows @param {string} [zone] @returns {{ key: string, at: number, items: T[] }[]} */
export function groupByDay(rows, zone) {
  /** @type {{ key: string, at: number, items: T[] }[]} */ const days = [];
  for (const e of rows) { const k = e.at ? dayKey(e.at, zone) : "none"; const g = days[days.length - 1]; if (g && g.key === k) g.items.push(e); else days.push({ key: k, at: e.at, items: [e] }); }
  return days;
}

/** What tapping an entry does: a chat opens the chat, a Flow run opens that run's page (the entry names the run and its Flow), a record entry opens the record; a stage move, a project start and a shared file are the story itself and open nothing. @param {{ type: string, id: string, chat?: string, run?: string, flow?: string }} e @returns {{ route: string } | null} */
export function entryAction(e) {
  if (e.type === "chat" && e.chat) return { route: `/u/chats/${e.chat}` };
  if (e.type === "flow-run") return e.run && e.flow ? { route: `/u/flows/${e.flow}?run=${e.run}` } : null;
  if (e.type === "stage" || e.type === "project-start" || e.type === "file-share") return null;
  return { route: `/u/record/${e.id}` };
}
