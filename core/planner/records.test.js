// @ts-check
// The planner keeps no tables: a reminder is a Reminder record, a note a Note record, a to-do a kernel Task assigned to the person, and the records are the truth.
// What the app, a Flow or another device does to them is read back in, and what the planner does shows in them.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, MIN, HOUR, T0, iso, OWNER } from "./testing.js";

/** What the app does: read the record, change it, and read again if the planner wrote it meanwhile. */
const edit = async (/** @type {any} */ w, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch) => {
  for (let i = 0; i < 5; i++) { try { return await w.k.gateway.records.update(w.owner, type, id, patch, (await w.k.gateway.records.get(w.owner, type, id)).version); } catch (e) { if (/** @type {any} */ (e).code !== "version_conflict") throw e; } }
  throw new Error("the record kept changing");
};

const until = async (/** @type {() => any} */ fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise(r => setTimeout(r, 25)); } };

test("records: alarms, timers and reminders are Reminder records, notes are Note records, and they come back after a restart", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  const a = await w.ok("planner.add", { kind: "alarm", title: "Northwind Bakery opens", wall: "07:00", list: "work", priority: 2, tags: ["bakery"], pinned: true });
  const r = await w.ok("planner.add", { kind: "reminder", title: "Call juno", at: iso(T0 + HOUR) });
  const n = await w.ok("planner.add", { kind: "note", title: "juno prefers mornings", body: "Mornings for calls", list: "people" });
  const rec = await R.get(w.owner, "reminder", a.id);
  assert.deepEqual([rec.data.kind, rec.data.title, rec.data.state, rec.data.list, rec.data.priority, rec.data.pinned, rec.data.tags, rec.data.wall, rec.data.source], ["alarm", "Northwind Bakery opens", "open", "work", 2, true, '["bakery"]', "07:00", "cli"]);
  assert.equal(rec.data.at, iso(a.at), "the time a person reads is a datetime");
  assert.equal((await R.get(w.owner, "reminder", r.id)).data.title, "Call juno");
  const note = await R.get(w.owner, "note", n.id);
  assert.deepEqual([note.data.title, note.data.body, note.data.list], ["juno prefers mornings", "Mornings for calls", "people"]);
  assert.equal((await R.query(w.owner, "reminder", { page: { limit: 10 } })).rows.length, 2);
  assert.equal((await R.query(w.owner, "note", { page: { limit: 10 } })).rows.length, 1);

  // A change shows in the record; a restart reads everything back.
  await w.ok("planner.update", { item: r.id, title: "Call juno about Northwind Bakery", priority: 3 });
  assert.equal((await R.get(w.owner, "reminder", r.id)).data.title, "Call juno about Northwind Bakery");
  await w.handle.stop();
  const w2 = await world(t, { kernel: w.k, start: w.clock.t });
  const list = await w2.ok("planner.list", { state: "all" });
  assert.deepEqual(list.map(x => x.title).sort(), ["Call juno about Northwind Bakery", "Northwind Bakery opens", "juno prefers mornings"]);
  assert.equal(list.find(x => x.id === a.id).pinned, true);
  w2.advance(HOUR);
  assert.deepEqual(w2.fired.map(f => f.item), [r.id], "the reminder still rings after the restart");
});

test("records: a reminder made or changed in the app is read back in, rings at its new time, and stops when finished", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  // Made in the app: no planner involved, nothing but the record.
  const made = await R.create(w.owner, "reminder", { title: "Renew licence", kind: "reminder", state: "open", at: iso(T0 + 2 * HOUR), created: T0, updated: T0 });
  const seen = await until(async () => (await w.ok("planner.list", {})).find(x => x.id === made.id));
  assert.ok(seen, "the planner follows the records");
  assert.equal(seen.next_fire, T0 + 2 * HOUR);
  // Moved in the app: its next ring follows.
  await edit(w, "reminder", made.id, { at: iso(T0 + 3 * HOUR) });
  await until(async () => (await w.ok("planner.get", { item: made.id })).item.next_fire === T0 + 3 * HOUR);
  w.advance(2 * HOUR + 1000);
  assert.equal(w.fired.length, 0, "not at the old time");
  w.advance(HOUR);
  assert.deepEqual(w.fired.map(f => f.item), [made.id]);
  // Finished in the app: it stops ringing.
  await edit(w, "reminder", made.id, { state: "done" });
  await until(async () => (await w.ok("planner.get", { item: made.id })).item.state === "done");
  const before = w.fired.length;
  w.advance(30 * MIN);
  assert.equal(w.fired.length, before, "an escalation does not ring for a finished reminder");
  assert.equal(w.acked.length, 1, "and the ring was closed");
});

test("records: a to-do is a Task assigned to the person; finishing it in the planner finishes the Task, and finishing the Task finishes it in the planner", async t => {
  const w = await world(t);
  const todo = await w.ok("planner.add", { kind: "todo", title: "Send the Harlow Legal engagement letter", due: "2026-09-26", list: "work", priority: 2, body: "Use the new template" });
  assert.equal(todo.due, "2026-09-26");
  assert.deepEqual([todo.list, todo.priority], ["work", 2]);
  const task = await w.k.tasks.get(w.owner, todo.id);
  assert.deepEqual([task.title, task.doer.id, task.state, task.note], ["Send the Harlow Legal engagement letter", OWNER, "ready", "Use the new template"]);
  assert.equal(task.form.planner.list, "work", "what a Task has no field for rides in its form");
  assert.equal((await w.k.gateway.records.query(w.owner, "reminder", { page: { limit: 5 } })).rows.length, 0, "no second to-do list");

  const done = await w.ok("planner.done", { item: todo.id });
  assert.equal(done.item.state, "done");
  assert.equal((await w.k.tasks.get(w.owner, todo.id)).state, "done");

  // Finished or skipped elsewhere (the Now screen): the planner follows.
  const b = await w.ok("planner.add", { kind: "todo", title: "File the Northwind Bakery return" });
  await w.k.tasks.start(w.owner, b.id);
  await w.k.tasks.complete(w.owner, b.id, { note: "Filed", sources: ["vyre://x/y/z"] });
  await until(async () => (await w.ok("planner.get", { item: b.id })).item.state === "done");
  assert.equal((await w.ok("planner.get", { item: b.id })).item.state, "done");

  // Cancelled in the planner: the Task is skipped.
  const c = await w.ok("planner.add", { kind: "todo", title: "Call the printer" });
  await w.ok("planner.delete", { item: c.id });
  assert.equal((await w.k.tasks.get(w.owner, c.id)).state, "skipped");
  assert.equal((await w.call("planner.delete", { item: c.id, restore: true })).error.code, "bad_input", "a cancelled to-do does not come back");

  // A to-do repeats nowhere and has no sub-items: those are what a Task is not.
  assert.equal((await w.call("planner.add", { kind: "todo", title: "Weekly report", wall: "09:00", repeat: { every: "week" } })).error.code, "bad_input");
  assert.equal((await w.call("planner.add", { kind: "todo", title: "Part", parent: todo.id })).error.code, "bad_input");
});

test("records: a to-do with an hour rings from the working set, and again after a restart", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_max: 0 });
  const todo = await w.ok("planner.add", { kind: "todo", title: "Call Dana Wine", at: iso(T0 + HOUR) });
  assert.equal(todo.next_fire, T0 + HOUR);
  await w.handle.stop();
  const w2 = await world(t, { kernel: w.k, start: T0 });
  w2.advance(HOUR);
  assert.deepEqual(w2.fired.map(f => [f.item, f.kind]), [[todo.id, "todo"]]);
});

test("records: a note edited in the app shows in the planner, and one removed there is gone", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  const n = await w.ok("planner.add", { kind: "note", title: "Draft", body: "one" });
  await edit(w, "note", n.id, { body: "two", title: "Final" });
  await until(async () => (await w.ok("planner.get", { item: n.id })).item.title === "Final");
  assert.deepEqual([(await w.ok("planner.get", { item: n.id })).item.body], ["two"]);
  await R.remove(w.owner, "note", n.id, (await R.get(w.owner, "note", n.id)).version);
  await until(async () => (await w.call("planner.get", { item: n.id })).error);
  assert.equal((await w.call("planner.get", { item: n.id })).error.code, "not_found");
});

test("records: the rings and the settings are records too, and a restart keeps what was answered", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_after: 7, escalate_max: 1 });
  const r = await w.ok("planner.add", { kind: "reminder", title: "Call kit", at: iso(T0 + HOUR) });
  w.advance(HOUR);
  const f = w.fired[0];
  await w.ok("planner.snooze", { firing: f.firing, minutes: 20 });
  const rings = await w.k.gateway.records.query(w.owner, "planner_firing", { page: { limit: 10 } });
  assert.deepEqual(rings.rows.map(x => [x.data.item, x.data.state, x.data.action]), [[r.id, "acked", "snooze"]]);
  await w.handle.stop();
  const w2 = await world(t, { kernel: w.k, start: w.clock.t });
  assert.deepEqual([(await w2.ok("planner.settings", {})).escalate_after, (await w2.ok("planner.settings", {})).escalate_max], [7, 1]);
  assert.equal((await w2.ok("planner.get", { item: r.id })).item.snooze_until, T0 + HOUR + 20 * MIN);
  w2.advance(20 * MIN);
  assert.equal(w2.fired.length, 1, "the snoozed reminder rang after the restart");
});

test("records: module.json declares exactly the planner's types and the Event type the connectors write, so a change to either is seen here", async () => {
  const fs = await import("node:fs");
  const { PLANNER_TYPES } = await import("./types.js");
  const { CORE_TYPES } = await import("../../records/core-types.js");
  const declared = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs.kernel.types;
  assert.deepEqual(declared, JSON.parse(JSON.stringify([...PLANNER_TYPES, CORE_TYPES.find(t => t.name === "event")])), "regenerate the needs.kernel.types block from types.js and records/core-types.js");
});
