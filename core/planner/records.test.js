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
  assert.deepEqual([rec.data.kind, rec.data.title, rec.data.state, rec.data.list, rec.data.priority, rec.data.pinned, rec.data.tags], ["alarm", "Northwind Bakery opens", "open", "work", 2, true, '["bakery"]']);
  assert.ok(!("wall" in rec.data) && !("source" in rec.data) && !("next_fire" in rec.data), "a person's read leaves out the engine's fields");
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
  const made = await R.create(w.owner, "reminder", { title: "Renew licence", kind: "reminder", state: "open", at: iso(T0 + 2 * HOUR) });
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
  assert.equal((await w.ok("planner.delete", { item: c.id, restore: true })).state, "open", "a deleted to-do comes back");
  assert.equal((await w.k.tasks.get(w.owner, c.id)).state, "ready");

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

test("records: module.json declares exactly the planner's own types; the Event type is the Space's shared one, defined once for every Space", async () => {
  const fs = await import("node:fs");
  const { PLANNER_TYPES } = await import("./types.js");
  const declared = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs.kernel.types;
  assert.deepEqual(declared, JSON.parse(JSON.stringify(PLANNER_TYPES)), "regenerate the needs.kernel.types block from types.js");
  assert.ok(!declared.some(/** @type {any} */ t => t.name === "event"), "the planner reads the shared Event type, it does not define one");
});

test("records: a to-do is edited, reopened, restored, made a sub-item and repeats, all as the same Task", async t => {
  const w = await world(t);
  const todo = await w.ok("planner.add", { kind: "todo", title: "Send the engagement letter", list: "work", priority: 1, body: "old template" });
  // Edit: words, list, priority, tags, due time, note.
  const e = await w.ok("planner.update", { item: todo.id, title: "Send the Harlow Legal engagement letter", list: "clients", priority: 3, tags: ["letters"], body: "new template", at: iso(T0 + 3 * HOUR) });
  assert.deepEqual([e.title, e.list, e.priority, e.tags, e.body, e.at], ["Send the Harlow Legal engagement letter", "clients", 3, ["letters"], "new template", T0 + 3 * HOUR]);
  await w.handle.stop();
  const task = await w.k.tasks.get(w.owner, todo.id);
  assert.deepEqual([task.title, task.note, task.due, task.form.planner.list, task.form.planner.priority], ["Send the Harlow Legal engagement letter", "new template", T0 + 3 * HOUR, "clients", 3], "the Task has the edit");
  const w2 = await world(t, { kernel: w.k, start: w.clock.t });
  assert.equal((await w2.ok("planner.get", { item: todo.id })).item.list, "clients", "and it survives a restart");
  // Done, then reopened.
  await w2.ok("planner.done", { item: todo.id });
  assert.equal((await w2.k.tasks.get(w2.owner, todo.id)).state, "done");
  const back = await w2.ok("planner.update", { item: todo.id, state: "open" });
  assert.equal(back.state, "open");
  assert.equal((await w2.k.tasks.get(w2.owner, todo.id)).state, "ready", "reopened");
  // Deleted, then restored.
  await w2.ok("planner.delete", { item: todo.id });
  assert.equal((await w2.k.tasks.get(w2.owner, todo.id)).state, "skipped");
  assert.equal((await w2.ok("planner.delete", { item: todo.id, restore: true })).state, "open");
  assert.equal((await w2.k.tasks.get(w2.owner, todo.id)).state, "ready");
  // Sub-items.
  const sub = await w2.ok("planner.add", { kind: "todo", title: "Get the client's address", parent: todo.id });
  assert.equal(sub.parent, todo.id);
  assert.deepEqual((await w2.k.tasks.list(w2.owner, { parent: todo.id })).map(x => x.id), [sub.id]);
  assert.equal((await w2.call("planner.add", { kind: "reminder", title: "x", wall: "09:00", parent: todo.id })).error.code, "not_found");
  assert.equal((await w2.call("planner.add", { kind: "todo", title: "x", parent: "nope" })).error.code, "not_found");
});

test("records: a repeating to-do makes the next Task when this one is done", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_max: 0 });
  const weekly = await w.ok("planner.add", { kind: "todo", title: "Weekly report", wall: "09:00", date: "2026-09-25", repeat: { every: "week" }, list: "work" });
  assert.ok(weekly.repeat);
  const done = await w.ok("planner.done", { item: weekly.id });
  assert.equal(done.item.state, "done");
  const open = (await w.ok("planner.list", { kind: "todo" }));
  assert.equal(open.length, 1, "one open to-do again");
  assert.notEqual(open[0].id, weekly.id);
  assert.deepEqual([open[0].title, open[0].list, open[0].wall], ["Weekly report", "work", "09:00"]);
  assert.ok(open[0].at > weekly.at, "a week on");
  assert.equal((await w.k.tasks.get(w.owner, open[0].id)).state, "ready");
});

test("records: the person gives a to-do to an assistant and it finishes it; one an assistant made for the person it cannot", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  const given = await w.ok("planner.add", { kind: "todo", title: "Check the docket", assignee: "kit" });
  assert.equal(given.assignee, "kit");
  const task = await w.k.tasks.get(w.owner, given.id);
  assert.deepEqual([task.doer.kind, task.doer.id], ["agent", "kit"]);
  assert.equal((await w.call("planner.add", { kind: "todo", title: "x", assignee: "kit" }, kit)).error.code, "denied", "only the person gives one");
  assert.equal((await w.call("planner.add", { kind: "todo", title: "x", assignee: "ghost" })).error.code, "not_found");
  assert.equal((await w.call("planner.add", { kind: "reminder", title: "x", wall: "09:00", assignee: "kit" })).error.code, "bad_input");
  // The assistant it was given to finishes it; another assistant does not.
  assert.equal((await w.call("planner.done", { item: given.id }, "mcp:agent:juno")).error.code, "denied");
  const finished = await w.ok("planner.done", { item: given.id }, kit);
  assert.equal(finished.item.state, "done");
  assert.equal((await w.k.tasks.get(w.owner, given.id)).state, "done");
  // One the assistant added for the person is not the assistant's to finish.
  const mine = await w.ok("planner.add", { kind: "todo", title: "Call the printer" }, kit);
  const refused = await w.call("planner.done", { item: mine.id }, kit);
  assert.equal(refused.error.code, "not_allowed");
  assert.equal((await w.ok("planner.get", { item: mine.id })).item.state, "open");
  assert.equal((await w.k.tasks.get(w.owner, mine.id)).state, "ready");
});

test("records: the person's default assistant acts as the person on a to-do; a project agent does not", async t => {
  const w = await world(t);
  const assistant = "mcp:agent:assistant", kit = "mcp:agent:kit";
  const mine = await w.ok("planner.add", { kind: "todo", title: "Draft the engagement letter" }, assistant);
  const done = await w.ok("planner.done", { item: mine.id }, assistant);
  assert.equal(done.item.state, "done", "the assistant acts as the person");
  assert.equal((await w.k.tasks.get(w.owner, mine.id)).state, "done");
  const edited = await w.ok("planner.add", { kind: "todo", title: "Call the printer" }, assistant);
  assert.equal((await w.ok("planner.update", { item: edited.id, title: "Call the printer today" }, assistant)).title, "Call the printer today");
  assert.equal((await w.ok("planner.update", { item: mine.id, state: "open" }, assistant)).state, "open", "and reopens it");
  const theirs = await w.ok("planner.add", { kind: "todo", title: "Check the docket" }, kit);
  assert.equal((await w.call("planner.done", { item: theirs.id }, kit)).error.code, "not_allowed", "a project agent that added one for the person cannot finish it");
});

test("records: a to-do names its project as a link to a Project record, or keeps a plain name", async t => {
  const w = await world(t);
  await w.k.gateway.records.define(w.owner, { add_types: [{ name: "project", label: "Project", fields: [{ name: "name", kind: "text", label: "Name", required: true }] }] });
  const p = await w.k.gateway.records.create(w.owner, "project", { name: "Northwind Bakery" });
  const linked = await w.ok("planner.add", { kind: "todo", title: "Send the invoice", project: p.urn });
  assert.equal(linked.project, p.urn);
  assert.equal((await w.k.tasks.get(w.owner, linked.id)).project, p.urn, "the Task carries the link");
  const plain = await w.ok("planner.add", { kind: "todo", title: "Buy flour", project: "northwind" });
  assert.equal(plain.project, "northwind");
  assert.equal((await w.k.tasks.get(w.owner, plain.id)).project, undefined, "a plain name stays in the form");
  assert.equal((await w.call("planner.add", { kind: "todo", title: "x", project: `vyre://${w.k.gateway ? "spc_aaaaaaaaaaaa" : ""}/project/nope` })).error.code, "bad_input", "a Project that is not there");
  const moved = await w.ok("planner.update", { item: plain.id, project: p.urn });
  assert.equal(moved.project, p.urn);
  assert.equal((await w.k.tasks.get(w.owner, plain.id)).project, p.urn);
});

test("records: the engine's own fields are hidden from every role and the reminder type offers a calendar view laid out by `at`", async t => {
  const w = await world(t);
  const types = await w.k.store.types();
  const rem = types.find(/** @type {any} */ x => x.name === "reminder"), note = types.find(/** @type {any} */ x => x.name === "note");
  const hidden = (/** @type {any} */ def) => def.fields.filter(/** @type {any} */ f => Array.isArray(f.hidden_from) && f.hidden_from.length === 5).map(/** @type {any} */ f => f.name).sort();
  assert.deepEqual(hidden(rem), ["added_by", "created", "date", "floating", "last_result", "next_fire", "run_count", "source", "updated", "waits_on_fired", "wall"]);
  assert.deepEqual(hidden(note), ["added_by", "created", "source", "updated"]);
  for (const person of ["title", "kind", "state", "at", "snooze_until", "body", "list", "priority", "pinned", "tags"]) assert.ok(!rem.fields.find(/** @type {any} */ f => f.name === person).hidden_from, `${person} is the person's`);
  assert.equal(rem.fields.find(/** @type {any} */ f => f.name === "at").kind, "datetime");
  const cal = rem.views.find(/** @type {any} */ v => v.type === "calendar");
  assert.deepEqual([cal.of, cal.dateField], ["reminder", "at"]);
});

test("records: on a Basic personal space the planner answers that it needs a Cloud space and lists the Cloud spaces the person is in; a Cloud space, or no answer, is not refused", async t => {
  const { forgetCloudGate } = await import("../../lib/cloud-gate.js");
  forgetCloudGate();
  const w = await world(t);
  w.tier = { tier: "basic", cloud: [{ id: "spc_harlow000001", name: "harlow.example", label: "harlow" }] };
  const r = await w.call("planner.add", { kind: "reminder", title: "Call juno", wall: "18:00" });
  assert.equal(r.error.code, "needs_cloud");
  assert.equal(r.error.message, "Planner needs a Cloud space");
  assert.ok(!/pro\b|server/i.test(r.error.message), "never Pro or server");
  assert.equal((await w.call("planner.list", {})).error.code, "needs_cloud", "reads too");
  assert.equal((await w.call("planner.parse", { text: "alarm 7am" })).error, undefined, "parsing words needs no space");
  forgetCloudGate();
  w.tier = { tier: "cloud", cloud: [] };
  assert.ok(!(await w.call("planner.add", { kind: "reminder", title: "Call juno", wall: "18:00" })).error, "a Cloud space works");
  forgetCloudGate();
  w.tier = null;
  assert.ok(!(await w.call("planner.list", {})).error, "no answer from the spaces module is not Basic");
  forgetCloudGate();
});
