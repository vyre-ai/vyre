// @ts-check
import { localParts, systemZone } from "../../../../lib/time/index.js";
// Who can read a note or an outside-calendar event, in the words a person uses, and the Busy blocks other people's private events leave on a calendar.

/** The levels a type offers, in order: a note has three, an event has no "record" level (it belongs to a calendar). @param {string} type */
export function shareLevels(type) {
  const all = [["private", "Only me"], ["record", "Whoever can see the record"], ["space", "Everyone in the Space"]];
  return type === "event" ? all.filter(([k]) => k !== "record") : all;
}

/** Whether a record is one the share control belongs on. @param {string} type */
export const isShareable = (type) => type === "note" || type === "record-note" || type === "event";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** One line for a Busy block: "Busy, Oct 20, 10:00 to 11:00" or "Busy, Oct 20, all day". Read through lib/time in the viewer's zone. @param {{ starts_at: any, ends_at?: any, all_day?: boolean }} b */
export function busyWords(b) {
  const at = new Date(b.starts_at).getTime();
  if (Number.isNaN(at)) return "Busy";
  const zone = systemZone();
  const s = localParts(at, zone);
  const day = `${MON[s.month - 1]} ${s.day}`;
  if (b.all_day) return `Busy, ${day}, all day`;
  const hm = (/** @type {{ hour: number, minute: number }} */ p) => `${two(p.hour)}:${two(p.minute)}`;
  const end = b.ends_at ? new Date(b.ends_at).getTime() : NaN;
  return `Busy, ${day}, ${hm(s)}${Number.isNaN(end) ? "" : ` to ${hm(localParts(end, zone))}`}`;
}
