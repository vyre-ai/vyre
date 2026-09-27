// @ts-check
// reminders: new reminders in the Reminders app, through its AppleScript dictionary.
//
// A due time crosses into AppleScript as numbers (year, month, day, and seconds into the day),
// which the script sets on a date. Text like "Friday 6 PM" would be parsed by the Mac's locale
// and read differently on a Mac set to another language. The day is set to 1 before the month,
// so moving from the 31st into a shorter month cannot roll over, and the time is set in one step.
// `remind me date` is set with the due date, so the reminder alerts rather than only sitting on
// the list.
//
// "Today" and "the past" are judged in env.timeZone (the Mac's own zone unless config says
// otherwise), the zone the due time is written in, never the zone of whatever runs the tests.

import { AppsError } from "../env.js";

const US = "\u001f", RS = "\u001e";

// The list is argv item 2: a list id from apps.targets, or a list name a person typed. An id is
// tried first, and read once so a wrong one fails inside the try (a reference is lazy).
export const CREATE = `on run argv
set argv to rest of argv
set theText to item 1 of argv
set listRef to item 2 of argv
set hasDue to item 3 of argv
set d to current date
if hasDue is "1" then
set day of d to 1
set year of d to (item 4 of argv) as integer
set month of d to (item 5 of argv) as integer
set day of d to (item 6 of argv) as integer
set time of d to (item 7 of argv) as integer
end if
tell application "Reminders"
if listRef is "" then
set theList to default list
else
try
set theList to list id listRef
get name of theList
on error
set theList to list listRef
end try
end if
if hasDue is "1" then
tell theList to set r to make new reminder with properties {name:theText, due date:d, remind me date:d}
else
tell theList to set r to make new reminder with properties {name:theText}
end if
return id of r
end tell
end run`;

export const LISTS = `on run argv
set argv to rest of argv
tell application "Reminders"
set theIds to id of every list
set theNames to name of every list
end tell
set recs to {}
repeat with i from 1 to count of theIds
set end of recs to (item i of theIds) & (character id 31) & (item i of theNames)
end repeat
set AppleScript's text item delimiters to character id 30
set out to recs as text
set AppleScript's text item delimiters to ""
return out
end run`;

/**
 * "2026-09-28T18:00" -> its numbers, or null when it is not a real date and time. Read as a
 * calendar date and a wall-clock time, not a moment, so no zone shifts it.
 * @param {string} s
 */
export function parseDue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return { y, mo, d, h, mi };
}

/**
 * The wall clock at `now` in a time zone, as numbers and as a sortable "YYYY-MM-DDTHH:MM".
 * @param {number} now @param {string} timeZone
 */
export function wallClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), iso };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How a person says a day relative to now: today, tomorrow, a weekday within the week, else a
 * date. In English words, never the locale's, so the Capsule reads the same everywhere.
 * @param {{ y: number, mo: number, d: number }} day @param {number} now @param {string} timeZone
 */
export function dayWords(day, now, timeZone) {
  const n = wallClock(now, timeZone);
  const at = Date.UTC(day.y, day.mo - 1, day.d);
  const days = Math.round((at - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return DAYS[new Date(at).getUTCDay()];
  return `${day.d} ${MONTHS[day.mo - 1]}${day.y !== n.y ? ` ${day.y}` : ""}`;
}

/** @type {import("./index.js").Adapter} */
export default {
  id: "reminders",
  app: "Reminders",
  bundleIds: ["com.apple.reminders"],
  tier: "script",
  actions: {
    create: {
      title: "New reminder",
      input: { type: "object", required: ["text"], properties: {
        text: { type: "string" },
        due: { type: "string", description: "Local date and time, YYYY-MM-DDTHH:MM." },
        list: { type: "string", description: "A list id from apps.targets, or a list name. Default: the default list." },
      } },
      sends: false,
      async run({ text, due, list }, env) {
        if (!String(text).trim()) throw new AppsError("bad_input", "a reminder needs some text");
        const given = due !== undefined && due !== "";
        const d = given ? parseDue(due) : null;
        if (given && !d) throw new AppsError("bad_input", `due must be a local date and time like 2026-09-28T18:00, not "${due}"`);
        // A time in the current minute counts as now, not the past.
        if (d && due < wallClock(env.now(), env.timeZone).iso) throw new AppsError("bad_input", "that time has passed");
        const argv = [String(text), list || "", d ? "1" : ""];
        if (d) argv.push(String(d.y), String(d.mo), String(d.d), String(d.h * 3600 + d.mi * 60));
        const id = await env.osa(CREATE, argv);
        const when = d ? `, ${dayWords(d, env.now(), env.timeZone)} at ${d.h}:${String(d.mi).padStart(2, "0")}` : "";
        return { said: `Reminder: ${text}${when}`, id, ...(d ? { due } : {}) };
      },
    },
  },
  /** Lists whose name contains q; the id is the list's own, which create takes as `list`. */
  async targets(q, env) {
    const needle = String(q || "").toLowerCase();
    return (await env.osa(LISTS, [])).split(RS).filter(Boolean).map(r => r.split(US))
      .filter(([id, name]) => id && (!needle || String(name).toLowerCase().includes(needle)))
      .map(([id, name]) => ({ id, title: name, kind: "list" }));
  },
};
