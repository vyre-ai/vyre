import { timeOf, weekdayDayOf } from "../../src/time/show.js";
// Planner (the Deck's views/planner.js, ported): today's agenda, the next alarms, open todos and notes, from the planner module (core/planner, ADR 0025). Pure: no calls.
// The planner's things are records in the Space now: an alarm, timer or reminder is a `reminder` record, a note a `note`, an event an `event`, a todo a kernel task (an item's id is the record's or the task's), so each opens where it lives.

export type Item = { id: string; kind: string; title: string; state?: string; at?: number | null; next_fire?: number | null; snooze_until?: number | null; repeat?: { every?: string; interval?: number } | null; pinned?: boolean; updated?: number; body?: string; added_by?: string; due?: string | null };
export type Entry = { item?: string; kind: string; title: string; at: number; all_day?: boolean; source: string; snoozed?: boolean };
export type Ringing = { firing: string; item: string; kind: string; title: string; due: number; missed?: boolean; added_by?: string };

const KIND_WORD: Record<string, string> = { alarm: "Alarm", timer: "Timer", reminder: "Reminder", todo: "Todo", note: "Note", event: "Event" };
export const kindWord = (k: string): string => KIND_WORD[k] || "Item";
/** Events that change what the lists show. */
export const CHANGES = ["planner.added", "planner.changed", "planner.removed", "planner.acked"];

/** When an item next rings (a snooze wins), or its time. */
export const nextAt = (it: Item): number | null => it.snooze_until ?? it.next_fire ?? it.at ?? null;

/** Open alarms and timers that will ring, soonest first. */
export function nextAlarms(items: Item[], limit = 5): Item[] {
  return items.filter((i) => (i.kind === "alarm" || i.kind === "timer") && i.state === "open" && nextAt(i) != null).sort((a, b) => (nextAt(a) as number) - (nextAt(b) as number)).slice(0, limit);
}
/** Pinned notes first, then the newest. */
export const sortNotes = (notes: Item[]): Item[] => [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updated || 0) - (a.updated || 0));

/** A repeat rule in words: "Daily", "Weekdays", "Every 2 weeks". */
export function repeatWord(r: Item["repeat"]): string {
  if (!r) return "";
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  const W: Record<string, string> = { day: "Daily", weekday: "Weekdays", week: "Weekly", month: "Monthly", year: "Yearly" };
  const U: Record<string, string> = { day: "days", week: "weeks", month: "months", year: "years" };
  return n > 1 && r.every && U[r.every] ? `Every ${n} ${U[r.every]}` : (r.every && W[r.every]) || "";
}

/** "todo buy milk" and "note printer code" say what kind they are; the rest is read by the planner ("alarm 7am", "remind me to ..."). */
export function splitKind(raw: string): { kind: "todo" | "note" | "event" | null; text: string } {
  const m = /^(todo|task|note|event)\b[\s:,-]*(.*)$/i.exec(String(raw || "").trim());
  if (!m) return { kind: null, text: String(raw || "").trim() };
  const k = m[1].toLowerCase();
  return { kind: (k === "task" ? "todo" : k) as "todo" | "note" | "event", text: m[2].trim() };
}

/** What the box read from the words, in a line the person can check before pressing Add. */
export function previewLine(p: any, words: string, fmt: (ms: number) => string = (ms) => `${weekdayDayOf(ms)}, ${timeOf(ms)}`): string {
  if (!p) return "I cannot place a time in that. Start with todo or note to add it as one.";
  if (p.ambiguous) return String(p.reason || "That is ambiguous: say the time or day.");
  return [kindWord(p.kind), p.title && p.title !== words ? p.title : "", p.at ? fmt(p.at) : "", repeatWord(p.repeat)].filter(Boolean).join(" · ");
}

/** The planner.add input for typed words: the kind when the words said it, else the planner reads them. */
export const addInput = (raw: string): { text: string; kind?: string } | null => {
  const { kind, text } = splitKind(raw);
  return text ? (kind ? { text, kind } : { text }) : null;
};

/** The clock time of a moment, like "9:30 am". */
export const clock = (ms: number): string => timeOf(ms);

/** planner.agenda's answer: entries (a planner item has `item`), the todos due, the planner's zone. */
export function agendaOf(d: any): { entries: Entry[]; todos: Item[]; tz: string } {
  return {
    entries: (Array.isArray(d?.entries) ? d.entries : []).filter((e: any) => e && typeof e.kind === "string").map((e: any): Entry => ({ item: e.item ? String(e.item) : undefined, kind: String(e.kind), title: String(e.title || ""), at: Number(e.at) || 0, all_day: e.all_day === true, source: String(e.source || "planner"), snoozed: e.snoozed === true })),
    todos: (Array.isArray(d?.todos) ? d.todos : []).filter((t: any) => t && typeof t.title === "string").map((t: any): Item => ({ id: String(t.id || ""), kind: "todo", title: t.title, due: t.due ? String(t.due) : null })),
    tz: String(d?.tz || ""),
  };
}

/** A planner.fired event's payload as a banner, or null. */
export function ringingOf(p: any): Ringing | null {
  if (!p || typeof p.firing !== "string") return null;
  return { firing: p.firing, item: String(p.item || ""), kind: String(p.kind || ""), title: String(p.title || ""), due: Number(p.due) || 0, missed: p.missed === true, added_by: p.added_by ? String(p.added_by) : undefined };
}

/** The page an item opens: a todo is a task (Now's task page); every other item is a record (Records, /u/records/reminder and /u/records/note, and the calendar's events). */
export const hrefOf = (it: { id: string; kind: string }): string => (it.kind === "todo" ? `/u/task/${encodeURIComponent(it.id)}` : `/u/record/${encodeURIComponent(it.id)}`);

/** Where the planner's kinds are listed now: Records and the calendar. */
export const PLACES: { label: string; href: string }[] = [
  { label: "Reminders", href: "/u/records/reminder" },
  { label: "Notes", href: "/u/records/note" },
  { label: "Calendar", href: "/u/calendar" },
];
