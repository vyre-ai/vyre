// @ts-check
// reminders: new reminders in the Reminders app, through its AppleScript dictionary.
//
// A due time crosses into AppleScript as numbers (year, month, day, hours, minutes), which the
// script sets one by one on a date. Text like "Friday 6 PM" would be parsed by the Mac's locale
// and read differently on a Mac set to another language. The day is set to 1 before the month,
// so moving from the 31st into a shorter month cannot roll over. `remind me date` is set with
// the due date, so the reminder alerts rather than only sitting on the list.

import { AppsError } from "../env.js";

const RS = "\u001e";

export const CREATE = `on run argv
set argv to rest of argv
set theText to item 1 of argv
set listName to item 2 of argv
set hasDue to item 3 of argv
set d to current date
if hasDue is "1" then
set day of d to 1
set year of d to (item 4 of argv) as integer
set month of d to (item 5 of argv) as integer
set day of d to (item 6 of argv) as integer
set hours of d to (item 7 of argv) as integer
set minutes of d to (item 8 of argv) as integer
set seconds of d to 0
end if
tell application "Reminders"
if listName is "" then
set theList to default list
else
set theList to list listName
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
set out to ""
tell application "Reminders"
set theNames to name of every list
end tell
repeat with n in theNames
set out to out & (contents of n) & (character id 30)
end repeat
return out
end run`;

/**
 * "2026-09-28T18:00" -> its numbers, or null when it is not a real local date and time.
 * @param {string} s
 */
export function parseDue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) return null;
  return { y, mo, d, h, mi, date };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How a person says a day relative to now: today, tomorrow, a weekday within the week, else a date.
 * In English words, never the locale's, so the Capsule reads the same everywhere.
 * @param {Date} date @param {number} now
 */
export function dayWords(date, now) {
  const start = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = new Date(now);
  const days = Math.round((start(date) - start(n)) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return DAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() !== n.getFullYear() ? ` ${date.getFullYear()}` : ""}`;
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
        list: { type: "string", description: "A list name. Default: the default list." },
      } },
      sends: false,
      async run({ text, due, list }, env) {
        if (!String(text).trim()) throw new AppsError("bad_input", "a reminder needs some text");
        const d = due === undefined || due === "" ? null : parseDue(due);
        if ((due !== undefined && due !== "") && !d) throw new AppsError("bad_input", `due must be a local date and time like 2026-09-28T18:00, not "${due}"`);
        const argv = [String(text), list || "", d ? "1" : ""];
        if (d) argv.push(String(d.y), String(d.mo), String(d.d), String(d.h), String(d.mi));
        const id = await env.osa(CREATE, argv);
        const when = d ? `, ${dayWords(d.date, env.now())} at ${d.h}:${String(d.mi).padStart(2, "0")}` : "";
        return { said: `Reminder: ${text}${when}`, id, ...(d ? { due } : {}) };
      },
    },
  },
  /** List names containing q. */
  async targets(q, env) {
    const needle = String(q || "").toLowerCase();
    return (await env.osa(LISTS, [])).split(RS).filter(Boolean)
      .filter(n => !needle || n.toLowerCase().includes(needle))
      .map(n => ({ id: n, title: n, kind: "list" }));
  },
};
