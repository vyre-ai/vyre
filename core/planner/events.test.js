// @ts-check
// The planner's calendar is the Space's Event records. A connector's sync (records/calendar/sync.js) writes them; here the test writes them the same way, through the
// gateway as the person, on a fake clock. The planner reads them, rings event_lead minutes before a start, and follows the kernel's own event.* events.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, fakeGoogle, MIN, HOUR, DAY, Z, T0, iso } from "./testing.js";

test("calendar: the planner reads Event records in its window, drops what is gone, and ignores the far and the long past", async t => {
  const w = await world(t);
  const a1 = await w.put({ title: "Harlow Legal intake", start: iso(T0 + 2 * HOUR), end: iso(T0 + 3 * HOUR), place: "Room 2" });
  await w.put({ title: "Offsite", start: "2026-09-25T00:00:00Z", end: "2026-09-26T00:00:00Z", all_day: true });
  await w.put({ title: "Far away", start: iso(T0 + 20 * DAY), end: iso(T0 + 20 * DAY + HOUR) });
  await w.put({ title: "Yesterday", start: iso(T0 - 3 * DAY), end: iso(T0 - 3 * DAY + HOUR) });
  const r = await w.read();
  assert.deepEqual([r.events, r.removed], [2, 0]);
  const up = await w.ok("planner.get", { item: a1.id });
  assert.deepEqual([up.item.kind, up.item.title, up.item.where, up.item.source], ["event", "Harlow Legal intake", "Room 2", "alex"]);
  await w.drop(a1);
  await w.read();
  assert.equal((await w.call("planner.upcoming", {})).data.entries.length, 0, "a removed record leaves the planner's window");
  assert.equal((await w.call("planner.get", { item: a1.id })).error.code, "not_found");
});

test("calendar: with no events there is no timer; with some, they are read again every 15 minutes", async t => {
  const w = await world(t);
  assert.equal(w.timers.size, 0, "no events, no timer");
  await w.advance(2 * HOUR);
  assert.equal(w.timers.size, 0);
  await w.put({ title: "Standup", start: iso(T0 + 5 * DAY), end: iso(T0 + 5 * DAY + HOUR) });
  await w.read();
  assert.ok([...w.timers.values()].every(x => x.ms >= MIN), "nothing sooner than a minute");
  assert.ok([...w.timers.values()].some(x => x.ms <= 15 * MIN), "the window is read again within 15 minutes");
});

test("calendar: a timed event rings once, event_lead before its start, however often it is read; an all-day one never rings", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const e1 = await w.put({ title: "Call juno", start: iso(start), end: iso(start + 30 * MIN) });
  await w.put({ title: "kit's birthday", start: "2026-09-24T00:00:00Z", end: "2026-09-25T00:00:00Z", all_day: true });
  await w.read();
  await w.advance(start - 10 * MIN - 1000 - T0);
  assert.equal(w.fired.length, 0);
  await w.advance(1000);
  assert.equal(w.fired.length, 1);
  const f = w.fired[0];
  assert.deepEqual({ ...f, firing: "x" }, { at: start - 10 * MIN, firing: "x", key: `planner-${e1.id}-${(start - 10 * MIN) / 1000}`, item: e1.id, kind: "event", title: "Call juno",
    due: start - 10 * MIN, ring: 1, missed: false, actions: ["done", "snooze"], account: "alex", start });
  // Renamed with the same start, read again by hand and by the timer: no second ring.
  await w.patch(e1, { title: "Call juno about Northwind Bakery" });
  await w.read(); await w.read();
  await w.advance(2 * DAY);
  assert.equal(w.fired.length, 1, "one ring for one start; all-day events never ring");

  // A moved event is a new start: it rings for that one.
  const later = w.clock.t + 3 * HOUR;
  const e2 = await w.put({ title: "Harlow Legal review", start: iso(later), end: iso(later + HOUR) });
  await w.read();
  const moved = later + HOUR;
  await w.patch(e2, { starts_at: iso(moved), ends_at: iso(moved + HOUR) });
  await w.read();
  await w.advance(6 * HOUR);
  assert.deepEqual(w.fired.slice(1).map(x => [x.item, x.at]), [[e2.id, moved - 10 * MIN]]);
});

test("calendar: a record written after the planner started rings without anyone asking it to read (it follows the kernel's events)", async t => {
  const w = await world(t);
  const start = T0 + 3 * HOUR;
  const e = await w.put({ title: "Supplier call", start: iso(start), end: iso(start + HOUR) });
  const until = Date.now() + 3000;
  let up = { entries: [] };
  while (Date.now() < until) { up = await w.ok("planner.upcoming"); if (up.entries.length) break; await new Promise(r => setTimeout(r, 25)); }
  assert.deepEqual(up.entries.map(x => x.item), [e.id], "the planner saw the record on its own");
  await w.drop(e);
  const gone = Date.now() + 3000;
  while (Date.now() < gone && (await w.ok("planner.upcoming")).entries.length) await new Promise(r => setTimeout(r, 25));
  assert.equal((await w.ok("planner.upcoming")).entries.length, 0, "and saw it go");
});

test("calendar: a ring snoozes and is done like any other; a new event_lead moves pending rings", async t => {
  const w = await world(t);
  const start = T0 + HOUR;
  await w.put({ title: "Northwind Bakery call", start: iso(start), end: iso(start + HOUR) });
  await w.read();
  await w.ok("planner.settings", { event_lead: 15 });
  await w.advance(HOUR - 15 * MIN);
  assert.equal(w.fired.length, 1);
  const s = await w.ok("planner.snooze", { firing: w.fired[0].firing, minutes: 5 });
  assert.equal(s.until, w.clock.t + 5 * MIN);
  assert.equal(s.item.source, "alex");
  await w.advance(5 * MIN);
  assert.equal(w.fired.length, 2, "rings again after the snooze");
  const got = await w.ok("planner.get", { firing: w.fired[1].firing });
  assert.equal(got.item.kind, "event");
  await w.ok("planner.done", { firing: w.fired[1].firing }, "deck");
  assert.deepEqual(w.acked.map(a => a.action), ["snooze", "done"]);
  assert.equal((await w.ok("planner.done", { firing: w.fired[1].firing })).already, true);
  assert.equal((await w.call("planner.done", { firing: w.fired[1].firing }, "mcp")).error.code, "denied", "an agent does not finish an event");
});

test("calendar: a restart keeps what already rang and a snooze that was pending", async t => {
  const w = await world(t);
  const start = T0 + HOUR;
  await w.put({ title: "Harlow Legal review", start: iso(start), end: iso(start + HOUR) });
  await w.read();
  await w.advance(HOUR - 10 * MIN);
  assert.equal(w.fired.length, 1);
  await w.ok("planner.snooze", { firing: w.fired[0].firing, minutes: 5 });
  await w.handle.stop();
  const w2 = await world(t, { kernel: w.k, start: w.clock.t });
  await w2.advance(5 * MIN);
  assert.equal(w2.fired.length, 1, "the snooze rang after the restart, and the first ring was not rung again");
  assert.equal(w2.fired[0].due, w.clock.t + 5 * MIN);
});

test("calendar: agenda merges the planner's events and every calendar's in order, with busy time merged across zones and a next shortcut", async t => {
  const w = await world(t);
  // 11:30 to 12:30 in Karachi, written in Los Angeles time; the record keeps an instant.
  await w.put({ title: "Harlow Legal intake", start: iso(Date.parse("2026-09-23T23:30:00-07:00")), end: iso(Date.parse("2026-09-24T00:30:00-07:00")), place: "https://meet.example/abc" });
  await w.put({ title: "Offsite", start: iso(Z(2026, 9, 23, 19)), end: iso(Z(2026, 9, 24, 19)), all_day: true });
  await w.put({ title: "Northwind Bakery tasting", start: iso(Date.parse("2026-09-24T16:00:00+09:00")), end: iso(Date.parse("2026-09-24T17:30:00+09:00")), calendar: "northwind" });
  await w.put({ title: "Supplier call", start: iso(Date.parse("2026-09-24T20:00:00+09:00")), end: iso(Date.parse("2026-09-24T21:00:00+09:00")), calendar: "northwind" });
  // The planner's own event, 10:30 to 11:45 in Karachi: it overlaps the intake.
  const own = await w.ok("planner.calendar.create", { title: "Plan with kit", start: "2026-09-24T10:30", end: "2026-09-24T11:45", where: "Studio" });
  await w.ok("planner.add", { kind: "alarm", title: "Stretch", wall: "11:30", date: "2026-09-24" });

  const day = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-24" });
  assert.deepEqual(day.entries.map(e => [e.source, e.title]), [
    ["alex", "Offsite"], ["planner", "Plan with kit"], ["planner", "Stretch"], ["alex", "Harlow Legal intake"], ["northwind", "Northwind Bakery tasting"], ["northwind", "Supplier call"]]);
  const intake = day.entries.find(e => e.title === "Harlow Legal intake");
  assert.deepEqual([intake.start, intake.end, intake.all_day, intake.where], [Z(2026, 9, 24, 6, 30), Z(2026, 9, 24, 7, 30), false, "https://meet.example/abc"]);
  const mine = day.entries.find(e => e.item === own.id);
  assert.deepEqual([mine.start, mine.end, mine.all_day, mine.where], [Z(2026, 9, 24, 5, 30), Z(2026, 9, 24, 6, 45), false, "Studio"]);
  assert.equal(day.entries[0].all_day, true);

  const busy = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-24", busy: true });
  assert.deepEqual(busy.busy.map(b => [iso(b.start), iso(b.end)]), [
    ["2026-09-24T05:30:00.000Z", "2026-09-24T08:30:00.000Z"],
    ["2026-09-24T11:00:00.000Z", "2026-09-24T12:00:00.000Z"]], "all-day and alarms are not busy; overlaps merge whatever zone they were written in");

  const next = await w.ok("planner.agenda", { next: 2 }, "mcp");
  assert.deepEqual(next.entries.map(e => e.title), ["Plan with kit", "Stretch"]);
  assert.ok(next.entries.every(e => e.at >= T0));
  assert.equal((await w.call("planner.agenda", { next: 0 })).error.code, "bad_input");
});

test("calendar: the planner's own event is an Event record (source vyre), and an invite on an account goes through google.calendar.create where attendees are held", async t => {
  const google = fakeGoogle();
  const w = await world(t, { google });
  const own = await w.ok("planner.calendar.create", { title: "Bake with juno", start: iso(T0 + 3 * HOUR) });
  assert.deepEqual([own.kind, own.at, own.duration_ms, own.source], ["event", T0 + 3 * HOUR, HOUR, "planner"]);
  const rec = (await w.k.gateway.records.get(w.owner, "event", own.id));
  assert.deepEqual([rec.data.title, rec.data.source, rec.data.starts_at, rec.data.time_zone], ["Bake with juno", "vyre", iso(T0 + 3 * HOUR), "Asia/Karachi"], "the same record a connector's sync writes");
  assert.equal(google.calls.filter(c => c[0] === "google.calendar.create").length, 0, "no account, nothing sent to Google");
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + HOUR), end: iso(T0) })).error.code, "bad_input");
  await w.advance(3 * HOUR);
  assert.deepEqual(w.fired.map(f => [f.title, f.at]), [["Bake with juno", T0 + 3 * HOUR - 10 * MIN]], "it rings like any event");

  // Attendees: the google module holds the invite at the Gate; nothing is written.
  const held = await w.ok("planner.calendar.create", { title: "Harlow Legal kickoff", start: "2026-09-25T15:00", account: "alex", attendees: ["kit@example.com"], where: "Harlow Legal" });
  assert.equal(held.held, "g_1");
  assert.match(held.message, /Held at the Gate/);
  const sent = google.calls.find(c => c[0] === "google.calendar.create")[1];
  assert.deepEqual(sent, { title: "Harlow Legal kickoff", start: "2026-09-25T10:00:00.000Z", account: "alex", time_zone: "Asia/Karachi", where: "Harlow Legal", attendees: ["kit@example.com"] });

  // An agent may ask for an invite (still held), and nothing else.
  const kit = "mcp:agent:kit";
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + 5 * HOUR) }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + 5 * HOUR), account: "alex" }, kit)).error.code, "denied");
  const asked = await w.ok("planner.calendar.create", { title: "Catch up", start: iso(T0 + 5 * HOUR), account: "alex", attendees: "juno@example.com" }, kit);
  assert.equal(asked.held, "g_2");
  assert.ok((await w.ok("planner.calendar.sync", {}, kit)).events >= 0, "agents may ask for a read");
});

test("calendar: upcoming carries the calendar's rings; one answered by key on a device never rings on the box", async t => {
  const w = await world(t);
  const a = T0 + 2 * HOUR, b = T0 + 3 * HOUR;
  const e1 = await w.put({ title: "Call juno", start: iso(a), end: iso(a + 30 * MIN) });
  const e2 = await w.put({ title: "Harlow Legal review", start: iso(b), end: iso(b + 30 * MIN) });
  await w.put({ title: "kit's birthday", start: "2026-09-24T00:00:00Z", end: "2026-09-25T00:00:00Z", all_day: true });
  const moved = [];
  w.events.on("planner.schedule", e => moved.push(e.payload.reason));
  await w.read();
  const up = await w.ok("planner.upcoming");
  const K = (ev, due) => `planner-${ev.id}-${due / 1000}`;
  assert.deepEqual(up.entries.map(e => [e.key, e.kind, e.account, e.start]), [[K(e1, a - 10 * MIN), "event", "alex", a], [K(e2, b - 10 * MIN), "event", "alex", b]]);
  await w.ok("planner.dismiss", { key: K(e1, a - 10 * MIN) });
  assert.equal(w.acked.at(-1).unrung, true);
  await w.advance(4 * HOUR);
  assert.deepEqual(w.fired.map(f => f.key), [K(e2, b - 10 * MIN)], "only the one nobody answered rang");
  const before = moved.length;
  await w.read();
  assert.equal(moved.length, before, "a read that changed nothing is quiet");
  await w.put({ title: "Northwind Bakery", start: iso(w.clock.t + DAY), end: iso(w.clock.t + DAY + HOUR) });
  await w.read();
  assert.ok(moved.slice(before).includes("calendar"), "a read that changed the window says the schedule moved");
});
