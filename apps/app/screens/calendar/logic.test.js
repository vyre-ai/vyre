import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay, collect, dateFields, dayHeading, heading, monthGrid, rangeOf, step, subLine, timeLine, today, weekStart, within } from "./logic.js";

const f = (name, kind, label = name) => ({ name, kind, label });
const EVENT = { name: "event", label: "Event", fields: [f("title", "text"), f("start", "datetime", "Starts"), f("end", "datetime", "Ends"), f("place", "text")] };
const MATTER = { name: "matter", label: "Matter", fields: [f("title", "text"), f("closing", "date", "Closing"), f("opened", "date", "Opened"), f("fee", "money")] };
const TASK = { name: "task_note", label: "Note", fields: [f("title", "text")] };
const types = [EVENT, MATTER, TASK];
const rec = (type, id, data) => ({ urn: `vyre://s/${type}/${id}`, id, type, data, version: 1 });
const byType = {
  event: [rec("event", "e1", { title: "Intake call", start: "2026-10-04T09:30:00", end: "2026-10-04T10:15:00" }), rec("event", "e2", { title: "Retreat", start: "2026-10-05", end: "2026-10-07" }), rec("event", "e3", { title: "No date" })],
  matter: [rec("matter", "m1", { title: "Doe trust", closing: "2026-10-04", opened: "2026-09-01" })],
  task_note: [rec("task_note", "t1", { title: "x" })],
};
const all = collect(types, byType);
const D = (s) => new Date(s);

test("an Event is read by its fields; any other type shows once for each date field; an undated record shows nowhere", () => {
  assert.deepEqual(dateFields(EVENT).start.name, "start");
  assert.deepEqual(dateFields(EVENT).end.name, "end");
  assert.deepEqual(dateFields(MATTER).others.map((x) => x.name), ["closing", "opened"], "the definition's calendar date first");
  assert.deepEqual(all.map((i) => [i.title, i.field]), [["Doe trust", "opened"], ["Doe trust", "closing"], ["Intake call", "start"], ["Retreat", "start"]]);
});

test("the range of a view: a day, the Monday-first week, the month", () => {
  const a = D("2026-10-04T12:00:00"); // a Sunday
  assert.equal(weekStart(a).getDate(), 28);
  assert.deepEqual([rangeOf("day", a), rangeOf("week", a), rangeOf("month", a)].map((r) => [r.from.getDate(), r.to.getDate(), r.to.getMonth()]), [[4, 5, 9], [28, 5, 9], [1, 1, 10]]);
  assert.deepEqual([step("day", a, 1).getDate(), step("week", a, -1).getDate(), step("month", a, 1).getMonth()], [5, 27, 10]);
});

test("a day lists what is on it: all-day first, then by time, with the type and date field named", () => {
  const { from, to } = rangeOf("day", D("2026-10-04T08:00:00"));
  const on = today(all, D("2026-10-04T08:00:00").getTime());
  assert.deepEqual(on.map((i) => i.title), ["Doe trust", "Intake call"]);
  assert.deepEqual(on.map((i) => subLine(i)), ["All day, Matter: Closing", "9:30 am to 10:15 am, Event"]);
  assert.equal(within(all, from, to).length, 2);
});

test("a multi-day all-day event shows on each day it covers, and an event ending at midnight does not spill into the next day", () => {
  const { from, to } = rangeOf("week", D("2026-10-05T12:00:00"));
  const days = byDay(all, from, to).filter((d) => d.items.some((i) => i.title === "Retreat")).map((d) => d.day);
  assert.deepEqual(days, ["2026-10-05", "2026-10-06", "2026-10-07"]);
  const late = collect([EVENT], { event: [rec("event", "e9", { title: "Late", start: "2026-10-04T22:00:00", end: "2026-10-05T00:00:00" })] });
  const wk = rangeOf("week", D("2026-10-05T12:00:00"));
  assert.deepEqual(byDay(late, ...[D("2026-10-04T00:00:00"), D("2026-10-06T00:00:00")]).map((d) => d.day), ["2026-10-04"]);
  assert.equal(wk.from.getDate(), 5);
});

test("a timed event that runs past midnight is on both days", () => {
  const night = collect([EVENT], { event: [rec("event", "e8", { title: "Night", start: "2026-10-04T22:00:00", end: "2026-10-05T01:00:00" })] });
  assert.deepEqual(byDay(night, D("2026-10-04T00:00:00"), D("2026-10-06T00:00:00")).map((d) => d.day), ["2026-10-04", "2026-10-05"]);
});

test("headings and times read as words", () => {
  const a = D("2026-10-04T12:00:00");
  assert.deepEqual([heading("month", a), heading("day", a), heading("week", a), dayHeading("2026-10-04")], ["October 2026", "Sunday 4 October", "Mon 28 Sep to Sun 4 Oct", "Sunday 4 October"]);
  assert.deepEqual([timeLine({ allDay: true }), timeLine({ allDay: false, start: D("2026-10-04T09:05:00"), end: null })], ["All day", "9:05 am"]);
});

test("the month grid is weeks of seven, Monday first, null outside the month", () => {
  const g = monthGrid(D("2026-10-15T00:00:00"));
  assert.ok(g.every((w) => w.length === 7));
  assert.deepEqual([g[0].filter(Boolean).length, g[0].findIndex(Boolean), g.flat().filter(Boolean).length], [4, 3, 31]);
});

import { occurrencesFrom, withOccurrences } from "./logic.js";
test("a repeating Event's occurrences come from planner.agenda and replace its single first-date item; the app expands no rule", () => {
  const T = Date.UTC(2026, 9, 6, 9);
  // planner.agenda's entries for a repeating event, as core/planner's events-repeat test reads them: record, start and end in ms, occurrence, rrule.
  const agenda = { entries: [
    { record: "ev1", title: "Board meeting", start: T, end: T + 3_600_000, occurrence: 0, rrule: "FREQ=WEEKLY" },
    { record: "ev1", title: "Board meeting", start: T + 7 * 86_400_000, end: T + 7 * 86_400_000 + 3_600_000, occurrence: 1, rrule: "FREQ=WEEKLY" },
    { record: "al1", title: "Ring", start: T, source: "planner" },
  ] };
  const occ = occurrencesFrom(agenda);
  assert.deepEqual(occ.map((o) => o.start.getTime()), [T, T + 7 * 86_400_000]);
  assert.equal(occ[0].end.getTime(), T + 3_600_000);
  const first = { urn: "vyre://s/event/ev1", id: "ev1", type: "event", typeLabel: "Event", title: "Board meeting", field: "start", fieldLabel: "Start", start: new Date(T - 200 * 86_400_000), end: null, allDay: false, event: true };
  const other = { urn: "vyre://s/event/ev2", id: "ev2", type: "event", typeLabel: "Event", title: "One-off", field: "start", fieldLabel: "Start", start: new Date(T + 3_600_000), end: null, allDay: false, event: true };
  const merged = withOccurrences([first, other], occ);
  assert.deepEqual(merged.map((i) => [i.id, i.start.getTime()]), [["ev1", T], ["ev2", T + 3_600_000], ["ev1", T + 7 * 86_400_000]]);
  assert.deepEqual(withOccurrences([first], []), [first], "no box answer: the first-date item stays");
});

test("a time that belongs to a space with its own zone also says the space's time; the viewer's zone alone otherwise", () => {
  // 16:00 UTC on 6 Oct 2026: 9:00 am in Pacific time, 9:00 pm in Karachi (lib/time's own words)
  const at = Date.UTC(2026, 9, 6, 16, 0);
  const item = { allDay: false, start: new Date(at), end: null };
  assert.equal(timeLine(item, { person: "Asia/Karachi", space: "America/Los_Angeles" }), "9:00 am PT · 9:00 pm your time");
  assert.equal(timeLine(item, { person: "Asia/Karachi", space: null }), "9:00 pm");
  assert.equal(timeLine(item, { person: "America/Los_Angeles", space: "America/Los_Angeles" }), "9:00 am");
});

test("a chat's started and last-active times are activity, not days on the calendar", () => {
  const CHAT = { name: "chat-record", label: "Chat", fields: [f("title", "text"), f("started", "datetime", "Started"), f("last_active", "datetime", "Last active")] };
  const chat = collect([CHAT, MATTER], { "chat-record": [rec("chat-record", "c1", { title: "New chat", started: "2026-10-04T09:30:00", last_active: "2026-10-04T09:45:00" })], matter: byType.matter });
  assert.deepEqual(chat.map((i) => i.type), ["matter", "matter"], "only the matter's two dates");
  assert.equal(chat.some((i) => i.title === "New chat"), false);
});
