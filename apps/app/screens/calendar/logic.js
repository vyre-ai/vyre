// The space calendar, as pure functions: every record with a date on it (an Event, a deadline, a task's due date) as one dated item, shown by day, week or month.
// Nothing here knows a record type. An Event type, when the space has one, is read by its fields: the first datetime field is the start, a field named
// like end/ends/until after it is the end. Any other type shows once for each date field it has.
import { clock, showTimes, systemZone } from "../../../../lib/time/index.js";
import { viewDefOf } from "../../src/store-core/view-defs.js";
import { isoDay, toDate } from "../../ui/fields/logic.js";

export const VIEWS = /** @type {const} */ (["day", "week", "month"]);
const DAY = 86_400_000;

/** @typedef {{ urn: string, id: string, type: string, typeLabel: string, title: string, field: string, fieldLabel: string, start: Date, end: Date | null, allDay: boolean, event: boolean }} Item */

const isDateField = (/** @type {any} */ f) => f.kind === "date" || f.kind === "datetime";
const ENDISH = /^(end|ends|end_at|ended|until|finish|to)$/i;

/** A type that is the space's own calendar: named event. @param {any} def */
export const isEventType = (def) => String(def.name).toLowerCase() === "event";

/** The date fields of a type: for an Event the start (and its end), for any other type every date or datetime field, the definition's calendar date first. @param {any} def */
export function dateFields(def) {
  const dated = (def.fields || []).filter(isDateField);
  if (isEventType(def)) {
    const start = dated.find((/** @type {any} */ f) => f.kind === "datetime" && !ENDISH.test(f.name)) || dated.find((/** @type {any} */ f) => !ENDISH.test(f.name)) || dated[0];
    if (!start) return { start: null, end: null, others: [] };
    const end = dated.find((/** @type {any} */ f) => f !== start && ENDISH.test(f.name)) || null;
    return { start, end, others: [] };
  }
  const first = viewDefOf(def).calendar?.date;
  return { start: null, end: null, others: [...dated].sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.name === first) - Number(a.name === first)) };
}

/** A record's title: the definition's title field, else its first text field, else its id. @param {any} def @param {any} rec */
function titleOf(def, rec) {
  const vd = viewDefOf(def);
  const v = rec?.data?.[vd.titleField] ?? (def.fields || []).map((/** @type {any} */ f) => rec?.data?.[f.name]).find((/** @type {any} */ x) => typeof x === "string" && x);
  return String(v ?? rec.id);
}

/** A value is a whole day when it carries no time: "2026-10-04", not an ISO datetime. @param {any} v */
const wholeDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Records whose dates are when something HAPPENED to them (a chat's start and last turn), not when something is due: they are the Space's activity, never a day on the calendar. */
export const NOT_SCHEDULED = Object.freeze(new Set(["chat-record"]));

/** Every dated record of every type as one item per date shown, soonest first. @param {any[]} types @param {Record<string, any[]>} byType @returns {Item[]} */
export function collect(types, byType) {
  /** @type {Item[]} */
  const out = [];
  for (const def of types) {
    if (NOT_SCHEDULED.has(String(def.name))) continue;
    const f = dateFields(def);
    const vd = viewDefOf(def);
    for (const rec of byType[def.name] || []) {
      const title = titleOf(def, rec);
      const base = { urn: rec.urn, id: rec.id, type: def.name, typeLabel: def.label || vd.plural || def.name, title };
      if (isEventType(def)) {
        if (!f.start) continue;
        const raw = rec.data?.[f.start.name], start = toDate(raw);
        if (!start) continue;
        const end = f.end ? toDate(rec.data?.[f.end.name]) : null;
        out.push({ ...base, field: f.start.name, fieldLabel: f.start.label || f.start.name, start, end: end && end >= start ? end : null, allDay: f.start.kind === "date" || wholeDay(raw), event: true });
      } else {
        for (const field of f.others) {
          const raw = rec.data?.[field.name], start = toDate(raw);
          if (start) out.push({ ...base, field: field.name, fieldLabel: field.label || field.name, start, end: null, allDay: field.kind === "date" || wholeDay(raw), event: false });
        }
      }
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
}

const startOfDay = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Monday of the week a day is in. @param {Date} d */
export const weekStart = (d) => { const s = startOfDay(d); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s; };

/** The range a view shows around an anchor: [from, to) in local time. @param {"day"|"week"|"month"} view @param {Date} anchor */
export function rangeOf(view, anchor) {
  if (view === "day") { const from = startOfDay(anchor); return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1) }; }
  if (view === "week") { const from = weekStart(anchor); return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7) }; }
  return { from: new Date(anchor.getFullYear(), anchor.getMonth(), 1), to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
}

/** The anchor n views later (negative for earlier). A month steps by month. @param {"day"|"week"|"month"} view @param {Date} anchor @param {number} n */
export function step(view, anchor, n) {
  if (view === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + n * (view === "week" ? 7 : 1));
}

/** The half-open span an item covers: a point is one millisecond, an all-day range runs to the end of its last day. @param {Item} i */
function span(i) {
  if (!i.end) return [i.start.getTime(), i.start.getTime() + 1];
  const e = i.allDay ? startOfDay(i.end).getTime() + DAY : i.end.getTime();
  return [i.start.getTime(), Math.max(e, i.start.getTime() + 1)];
}

/** An item is in a range when any part of it is: a timed event that runs past midnight shows on both days. @param {Item[]} items @param {Date} from @param {Date} to */
export function within(items, from, to) {
  return items.filter((i) => { const [s, e] = span(i); return s < to.getTime() && e > from.getTime(); });
}

/** The days of a range that have items, each as { day: "2026-10-04", items }, in order. A multi-day item is listed on every day it covers inside the range. @param {Item[]} items @param {Date} from @param {Date} to */
export function byDay(items, from, to) {
  /** @type {Map<string, Item[]>} */
  const map = new Map();
  for (const i of within(items, from, to)) {
    const [s, e] = span(i);
    const first = startOfDay(new Date(Math.max(s, from.getTime())));
    const last = startOfDay(new Date(Math.min(e, to.getTime()) - 1));
    for (let d = first; d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const k = isoDay(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k)?.push(i);
    }
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, list]) => ({ day, items: list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime()) }));
}

/** What is on today, for Now: soonest first, all-day ones first. @param {Item[]} items @param {number} now */
export function today(items, now) {
  const { from, to } = rangeOf("day", new Date(now));
  return byDay(items, from, to)[0]?.items ?? [];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** The heading for a view: "October 2026", "Mon 28 Sep to Sun 4 Oct", "Sunday 4 October". @param {"day"|"week"|"month"} view @param {Date} anchor */
export function heading(view, anchor) {
  if (view === "month") return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  if (view === "day") return `${DAYS[anchor.getDay()]} ${anchor.getDate()} ${MONTHS[anchor.getMonth()]}`;
  const a = weekStart(anchor), b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
  const d = (/** @type {Date} */ x) => `${DAYS[x.getDay()].slice(0, 3)} ${x.getDate()} ${SHORT[x.getMonth()]}`;
  return `${d(a)} to ${d(b)}`;
}

/**
 * "9:30 am" or "All day"; a timed event with an end says "9:30 am to 10:15 am". Every time is shown in the viewer's own zone (lib/time, the one place that converts); a time that belongs to a space with a zone
 * of its own also says the space's: "9:00 am PT · 9:00 pm your time". With no zone given the viewer's device zone is used and no space zone is shown.
 * @param {Item} i @param {{ person?: string, space?: string | null }} [z]
 */
export function timeLine(i, z = {}) {
  if (i.allDay) return "All day";
  const person = z.person || systemZone();
  const first = showTimes(i.start.getTime(), { person, space: z.space ?? null }).text;
  return i.end ? `${first} to ${clock(i.end.getTime(), person)}` : first;
}

/** The line under a title: when, then what it is ("Deadline" for a Matter's closing date, "Event" for an Event). @param {Item} i @param {{ person?: string, space?: string | null }} [z] */
export const subLine = (i, z) => `${timeLine(i, z)}, ${i.event ? i.typeLabel : `${i.typeLabel}: ${i.fieldLabel}`}`;

/** A day key as a heading for an agenda: "Sunday 4 October". @param {string} key */
export function dayHeading(key) { const d = toDate(key); return d ? heading("day", d) : key; }

/** The days of the month the month view draws as weeks of seven, Monday first, as Dates (the days before and after the month are null). @param {Date} anchor */
export function monthGrid(anchor) {
  const y = anchor.getFullYear(), m = anchor.getMonth(), days = new Date(y, m + 1, 0).getDate(), lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(y, m, i + 1))];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/**
 * A repeating Event's occurrences come from the box, not from the app: planner.agenda { from, to } answers every occurrence of an Event inside the window, each with its record, start and end (ms),
 * all_day, url, occurrence and the rrule (core/planner, planner-events). The app does not expand a rule itself. An entry is an occurrence when it has a record and a rule.
 * @param {any} agenda planner.agenda's answer: { entries: [...] } @returns {Item[]}
 */
export function occurrencesFrom(agenda) {
  const rows = Array.isArray(agenda?.entries) ? agenda.entries : [];
  /** @type {Item[]} */ const out = [];
  for (const e of rows) {
    if (!e || typeof e.record !== "string" || !e.rrule || typeof e.start !== "number") continue;
    out.push({ urn: `occurrence:${e.record}:${e.start}`, id: e.record, type: "event", typeLabel: "Event", title: String(e.title ?? "Event"), field: "start", fieldLabel: "Start", start: new Date(e.start), end: typeof e.end === "number" && e.end >= e.start ? new Date(e.end) : null, allDay: e.all_day === true, event: true });
  }
  return out;
}

/** The record items with each repeating Event's single first-date item replaced by the box's occurrences in the window. @param {Item[]} items @param {Item[]} occurrences */
export function withOccurrences(items, occurrences) {
  if (!occurrences.length) return items;
  const repeating = new Set(occurrences.map((o) => o.id));
  return [...items.filter((i) => !(i.event && repeating.has(i.id))), ...occurrences].sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
}
