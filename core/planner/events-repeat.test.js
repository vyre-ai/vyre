// @ts-check
// A repeating event is one Event record with an `rrule`. The planner expands it: each occurrence rings on its own, shows in the agenda, and is read in the event's zone.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, MIN, HOUR, DAY, Z, T0, iso } from "./testing.js";

test("repeat: a daily event rings once per day, each occurrence on its own key", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const e = await w.put({ title: "Standup", start: iso(start), end: iso(start + 15 * MIN), rrule: "FREQ=DAILY" });
  await w.read();
  await w.advance(3 * DAY);
  assert.deepEqual(w.fired.map(f => f.item), [0, 1, 2].map(n => `${e.id}~${start + n * DAY}`));
  assert.deepEqual(w.fired.map(f => f.due), [0, 1, 2].map(n => start + n * DAY - 10 * MIN));
  assert.equal(new Set(w.fired.map(f => f.key)).size, 3);
  // an answer by key reaches the right occurrence
  const done = await w.ok("planner.done", { key: w.fired[2].key });
  assert.equal(done.firing.state, "acked");
  assert.deepEqual([w.acked.at(-1).item], [w.fired[2].item]);
});

test("repeat: an unanswered occurrence gives way to the next one", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  await w.put({ title: "Standup", start: iso(start), end: iso(start + 15 * MIN), rrule: "FREQ=DAILY" });
  await w.read();
  await w.advance(2 * DAY + HOUR);
  const ringing = (await w.ok("planner.ringing")).filter(r => r.kind === "event");
  assert.equal(ringing.length, 1, "only the latest occurrence is still ringing");
});

test("repeat: the agenda lists each occurrence, COUNT and UNTIL end it, and the first start is the record's own", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const daily = await w.put({ title: "Daily", start: iso(start), end: iso(start + HOUR), rrule: "FREQ=DAILY;COUNT=2" });
  const weekly = await w.put({ title: "Weekly", start: iso(start), end: iso(start + HOUR), rrule: `FREQ=WEEKLY;UNTIL=${iso(start + 8 * DAY).replace(/[-:]|\.\d+/g, "")}` });
  const a = await w.ok("planner.agenda", { from: iso(T0), to: iso(T0 + 10 * DAY) });
  const mine = (/** @type {any} */ rec) => a.entries.filter((/** @type {any} */ x) => x.record === rec.id).map((/** @type {any} */ x) => x.start);
  assert.deepEqual(mine(daily), [start, start + DAY]);
  assert.deepEqual(mine(weekly), [start, start + 7 * DAY]);
  assert.ok(a.entries.filter((/** @type {any} */ x) => x.record === daily.id).every((/** @type {any} */ x) => x.occurrence && x.rrule === "FREQ=DAILY;COUNT=2"));
  assert.equal(a.entries.find((/** @type {any} */ x) => x.record === daily.id).end, start + HOUR);
});

test("repeat: an old repeating event is found by its rule, not its first start", async t => {
  const w = await world(t);
  const first = T0 - 200 * DAY;
  const e = await w.put({ title: "Board meeting", start: iso(first), end: iso(first + HOUR), rrule: "FREQ=WEEKLY" });
  const a = await w.ok("planner.agenda", { from: iso(T0), to: iso(T0 + 14 * DAY) });
  const got = a.entries.filter((/** @type {any} */ x) => x.record === e.id).map((/** @type {any} */ x) => x.start);
  assert.equal(got.length, 2);
  assert.ok(got.every((/** @type {number} */ s) => (s - first) % (7 * DAY) === 0 && s >= T0));
});

test("repeat: a rule is kept in the event's own zone across New York's clock change", async t => {
  const w = await world(t);
  const first = Z(2026, 10, 30, 13); // 09:00 EDT
  const e = await w.put({ title: "NY call", start: iso(first), end: iso(first + HOUR), rrule: "FREQ=DAILY", time_zone: "America/New_York" });
  const a = await w.ok("planner.agenda", { from: iso(Z(2026, 10, 30)), to: iso(Z(2026, 11, 3)) });
  assert.deepEqual(a.entries.filter((/** @type {any} */ x) => x.record === e.id).map((/** @type {any} */ x) => x.start), [Z(2026, 10, 30, 13), Z(2026, 10, 31, 13), Z(2026, 11, 1, 14), Z(2026, 11, 2, 14)]);
});

test("repeat: editing the rule re-expands it, and removing the record cancels every occurrence", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const e = await w.put({ title: "Standup", start: iso(start), end: iso(start + 15 * MIN), rrule: "FREQ=DAILY" });
  await w.read();
  let up = await w.ok("planner.upcoming", { hours: 72 });
  assert.equal(up.entries.filter((/** @type {any} */ x) => x.kind === "event").length, 3);
  await w.patch(e, { rrule: "FREQ=DAILY;COUNT=2" });
  await w.read();
  up = await w.ok("planner.upcoming", { hours: 72 });
  assert.equal(up.entries.filter((/** @type {any} */ x) => x.kind === "event").length, 2, "the third occurrence is gone with the old rule");
  await w.advance(3 * HOUR);
  assert.equal((await w.ok("planner.ringing")).filter((/** @type {any} */ r) => r.kind === "event").length, 1);
  await w.drop(e);
  await w.read();
  assert.equal((await w.ok("planner.upcoming", { hours: 72 })).entries.length, 0);
  assert.equal((await w.ok("planner.ringing")).filter((/** @type {any} */ r) => r.kind === "event").length, 0, "removing the event stops what was ringing");
});

test("repeat: planner.add and planner.calendar.create make a repeating event with a link; bad rules and links are refused", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const made = await w.ok("planner.calendar.create", { title: "Retro", start: iso(start), end: iso(start + HOUR), rrule: "FREQ=WEEKLY;BYDAY=TH", url: "https://example.com/retro" });
  assert.equal(made.rrule, "FREQ=WEEKLY;BYDAY=TH");
  assert.equal(made.url, "https://example.com/retro");
  const rec = await w.k.gateway.records.get(w.owner, "event", made.record);
  assert.deepEqual([rec.data.rrule, rec.data.url, rec.data.source], ["FREQ=WEEKLY;BYDAY=TH", "https://example.com/retro", "vyre"]);
  const viaAdd = await w.ok("planner.add", { kind: "event", title: "Review", at: iso(start), rrule: "RRULE:FREQ=DAILY;COUNT=3" });
  assert.equal((await w.k.gateway.records.get(w.owner, "event", viaAdd.record)).data.rrule, "FREQ=DAILY;COUNT=3", "an RRULE: prefix is dropped");
  for (const [bad, why] of [[{ rrule: "FREQ=HOURLY" }, /rrule: FREQ is one of/], [{ url: "javascript:alert(1)" }, /web address/], [{ rrule: "FREQ=DAILY;COUNT=2;UNTIL=20270101" }, /not both/]]) {
    const r = await w.call("planner.calendar.create", { title: "x", start: iso(start), ...bad });
    assert.match(String(r.error && r.error.message), why);
  }
  const rem = await w.call("planner.add", { kind: "reminder", title: "x", at: iso(start), rrule: "FREQ=DAILY" });
  assert.match(String(rem.error && rem.error.message), /for events/);
});

test("repeat: updating an occurrence by its id changes the event record, and the link is cleared with null", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const made = await w.ok("planner.calendar.create", { title: "Retro", start: iso(start), end: iso(start + HOUR), rrule: "FREQ=DAILY", url: "https://example.com/r" });
  const a = await w.ok("planner.agenda", { from: iso(T0), to: iso(T0 + 3 * DAY) });
  const second = a.entries.find((/** @type {any} */ x) => x.record === made.record && x.start === start + DAY);
  assert.ok(second && String(second.item).endsWith(`~${start + DAY}`));
  await w.ok("planner.update", { item: second.item, title: "Retro (weekly)", url: null, rrule: "FREQ=DAILY;COUNT=2" });
  const rec = await w.k.gateway.records.get(w.owner, "event", made.record);
  assert.deepEqual([rec.data.title, rec.data.url ?? null, rec.data.rrule], ["Retro (weekly)", null, "FREQ=DAILY;COUNT=2"]);
});
