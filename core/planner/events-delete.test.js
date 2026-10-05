// @ts-check
// Deleting an event is the records' own remove (the bin) and restoring it is the records' own restore, so a restore works after a restart and the Records screens see the same bin.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, MIN, HOUR, DAY, T0, iso } from "./testing.js";

test("delete: the planner's own event goes to the bin and comes back, still ringing, and a connected calendar's event is not deleted here", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const mine = await w.ok("planner.calendar.create", { title: "Retro", start: iso(start), end: iso(start + HOUR) });
  const theirs = await w.put({ title: "Their call", start: iso(start), end: iso(start + HOUR) });
  await w.read();
  const gone = await w.ok("planner.delete", { item: mine.id });
  assert.equal(gone.removed, mine.id);
  assert.equal((await w.k.gateway.records.get(w.owner, "event", mine.id)), null, "the record is in the bin, not in the Space's list");
  assert.deepEqual((await w.ok("planner.upcoming", { hours: 12 })).entries.map((/** @type {any} */ x) => x.item), [theirs.id], "its ring is gone");
  const denied = await w.call("planner.delete", { item: theirs.id });
  assert.equal(denied.error.code, "denied");
  assert.match(denied.error.message, /delete it there/);
  const back = await w.ok("planner.delete", { item: mine.id, restore: true });
  assert.equal(back.record, mine.id);
  assert.equal((await w.k.gateway.records.get(w.owner, "event", mine.id)).data.title, "Retro");
  assert.deepEqual((await w.ok("planner.upcoming", { hours: 12 })).entries.map((/** @type {any} */ x) => x.item).sort(), [mine.id, theirs.id].sort(), "its ring is back");
  await w.advance(2 * HOUR);
  assert.ok(w.fired.some(f => f.item === mine.id), "the restored event rings");
});

test("delete: a repeating event is deleted and restored by its record, or by any occurrence's id", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const made = await w.ok("planner.calendar.create", { title: "Standup", start: iso(start), end: iso(start + 15 * MIN), rrule: "FREQ=DAILY" });
  const a = await w.ok("planner.agenda", { from: iso(T0), to: iso(T0 + 3 * DAY) });
  const occ = a.entries.filter((/** @type {any} */ x) => x.record === made.record);
  assert.equal(occ.length, 3);
  await w.ok("planner.delete", { item: occ[1].item });
  assert.equal((await w.ok("planner.upcoming", { hours: 72 })).entries.length, 0, "every occurrence is gone with the record");
  await w.ok("planner.delete", { item: made.record, restore: true });
  assert.equal((await w.ok("planner.upcoming", { hours: 72 })).entries.length, 3);
});

test("delete: an event deleted before a restart is restored after it", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const mine = await w.ok("planner.calendar.create", { title: "Retro", start: iso(start), end: iso(start + HOUR), rrule: "FREQ=WEEKLY", url: "https://example.com/retro" });
  await w.ok("planner.delete", { item: mine.id });
  // a new planner over the same Space: it has never seen the event
  const again = await world(t, { kernel: w.k });
  assert.equal((await again.call("planner.get", { item: mine.id })).error.code, "not_found");
  assert.equal((await again.ok("planner.upcoming", { hours: 72 })).entries.length, 0);
  const back = await again.ok("planner.delete", { item: mine.id, restore: true });
  assert.deepEqual([back.record, back.rrule, back.url], [mine.record, "FREQ=WEEKLY", "https://example.com/retro"]);
  assert.ok((await again.ok("planner.upcoming", { hours: 72 })).entries.length >= 1);
  const none = await again.call("planner.delete", { item: "ev_nothing", restore: true });
  assert.equal(none.error.code, "not_found");
});

test("delete: an agent may not delete an event", async t => {
  const w = await world(t);
  const start = T0 + 2 * HOUR;
  const mine = await w.ok("planner.calendar.create", { title: "Retro", start: iso(start), end: iso(start + HOUR) });
  const r = await w.call("planner.delete", { item: mine.id }, "agent");
  assert.ok(r.error, "an agent's call is refused");
  assert.ok(await w.k.gateway.records.get(w.owner, "event", mine.id), "and the event is still there");
});
