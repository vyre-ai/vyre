// @ts-check
// Who can read a note or an outside-calendar event, in the words a person uses, and the Busy blocks other people's private events leave on a calendar.

/** The levels a type offers, in order: a note has three, an event has no "record" level (it belongs to a calendar). @param {string} type */
export function shareLevels(type) {
  const all = [["private", "Only me"], ["record", "Whoever can see the record"], ["space", "Everyone in the Space"]];
  return type === "event" ? all.filter(([k]) => k !== "record") : all;
}

/** Whether a record is one the share control belongs on. @param {string} type */
export const isShareable = (type) => type === "record-note" || type === "event";

/** One line for a Busy block: "Busy, Oct 20, 10:00 to 11:00" or "Busy, Oct 20, all day". @param {{ starts_at: any, ends_at?: any, all_day?: boolean }} b */
export function busyWords(b) {
  const s = new Date(b.starts_at);
  if (Number.isNaN(s.getTime())) return "Busy";
  const day = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (b.all_day) return `Busy, ${day}, all day`;
  const t = (/** @type {Date} */ d) => d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const e = b.ends_at ? new Date(b.ends_at) : null;
  return `Busy, ${day}, ${t(s)}${e && !Number.isNaN(e.getTime()) ? ` to ${t(e)}` : ""}`;
}
