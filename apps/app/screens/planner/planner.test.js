// @ts-check
// Planner (the Deck's views/planner.js, ported): what is drawn from planner.list and planner.agenda, the words read before Add, and the calls behind each button, over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const ITEMS = [
  { id: "a1", kind: "alarm", title: "Wake", state: "open", next_fire: 300, repeat: { every: "weekday" } },
  { id: "a2", kind: "timer", title: "Tea", state: "open", at: 100 },
  { id: "a3", kind: "alarm", title: "Snoozed", state: "open", next_fire: 50, snooze_until: 400 },
  { id: "a4", kind: "alarm", title: "Done one", state: "done", next_fire: 10 },
  { id: "n1", kind: "note", title: "Printer", pinned: false, updated: 9 },
  { id: "n2", kind: "note", title: "Wifi", pinned: true, updated: 1 },
  { id: "n3", kind: "note", title: "Newer", pinned: false, updated: 20 },
];

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] || { data: tool === "planner.list" ? ITEMS : {} }; };
  return { call, seen };
}

test("alarms: open ones that will ring, soonest first, a snooze wins over the schedule", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const next = m.nextAlarms(ITEMS);
  assert.deepEqual(next.map((i) => i.id), ["a2", "a1", "a3"]);
  assert.deepEqual(next.map(m.nextAt), [100, 300, 400]);
  assert.equal(m.nextAlarms(ITEMS, 2).length, 2);
});

test("notes: pinned first, then the newest", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.sortNotes(ITEMS.filter((i) => i.kind === "note")).map((i) => i.id), ["n2", "n3", "n1"]);
});

test("repeat rules read in words", { skip: !strip }, async () => {
  const { repeatWord } = await import("./model.ts");
  assert.deepEqual([repeatWord(null), repeatWord({ every: "day" }), repeatWord({ every: "weekday" }), repeatWord({ every: "week", interval: 2 }), repeatWord({ every: "weekday", interval: 3 }), repeatWord({ every: "x" })], ["", "Daily", "Weekdays", "Every 2 weeks", "Weekdays", ""]);
});

test("typed words: todo, task, note and event say their kind, the rest are the planner's to read", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.splitKind("todo buy milk"), { kind: "todo", text: "buy milk" });
  assert.deepEqual(m.splitKind("Task: send the invoice"), { kind: "todo", text: "send the invoice" });
  assert.deepEqual(m.splitKind("note printer code 4471"), { kind: "note", text: "printer code 4471" });
  assert.deepEqual(m.splitKind("notebook sale friday"), { kind: null, text: "notebook sale friday" }, "a word that only starts with note is not a kind");
  assert.deepEqual(m.splitKind("alarm 7am"), { kind: null, text: "alarm 7am" });
  assert.deepEqual(m.addInput("todo buy milk"), { text: "buy milk", kind: "todo" });
  assert.deepEqual(m.addInput("alarm 7am"), { text: "alarm 7am" });
  assert.equal(m.addInput("   "), null);
  assert.equal(m.addInput("todo"), null, "a kind with no words adds nothing");
});

test("preview: what the box read, or why it cannot", { skip: !strip }, async () => {
  const { previewLine } = await import("./model.ts");
  const fmt = () => "Fri 7:00 am";
  assert.match(previewLine(null, "x"), /cannot place a time/);
  assert.equal(previewLine({ ambiguous: true, reason: "Which Friday?" }, "x"), "Which Friday?");
  assert.equal(previewLine({ kind: "alarm", title: "alarm 7am", at: 1, repeat: { every: "weekday" } }, "alarm 7am", fmt), "Alarm · Fri 7:00 am · Weekdays");
  assert.equal(previewLine({ kind: "reminder", title: "call the bank", at: 1 }, "remind me to call the bank at 6", fmt), "Reminder · call the bank · Fri 7:00 am");
});

test("agenda and ringing: only well-formed rows come through", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const a = m.agendaOf({ tz: "Europe/Lisbon", entries: [{ kind: "alarm", title: "Wake", at: 5, item: "a1", source: "planner" }, { kind: "event", title: "Call", at: 6, source: "me@x.example" }, { nope: 1 }, null], todos: [{ id: "t1", title: "Pay", due: "2026-10-06" }, { id: "t2" }] });
  assert.deepEqual([a.tz, a.entries.length, a.todos.length], ["Europe/Lisbon", 2, 1]);
  assert.equal(a.entries[1].source, "me@x.example");
  assert.equal(m.ringingOf({ nope: 1 }), null);
  assert.deepEqual(m.ringingOf({ firing: "f1", item: "a1", kind: "alarm", title: "Wake", due: 9 }), { firing: "f1", item: "a1", kind: "alarm", title: "Wake", due: 9, missed: false, added_by: undefined });
});

test("calls: add, done, reopen, delete, restore and answering a ring are one planner call each", { skip: !strip }, async () => {
  const { plannerSource } = await import("./source.ts");
  const b = box({ "planner.ringing": { data: [{ firing: "f1", item: "a1", kind: "alarm", title: "Wake", due: 9 }, { bad: 1 }] } });
  const s = plannerSource(b.call);
  await s.add({ text: "buy milk", kind: "todo" }); await s.done("t1"); await s.reopen("t1"); await s.remove("t1"); await s.restore("t1");
  await s.answer("planner.snooze", "f1"); await s.parse("alarm 7am"); await s.parse("x", "event");
  assert.deepEqual((await s.ringing()).map((r) => r.firing), ["f1"]);
  assert.equal((await s.open()).length, ITEMS.length);
  assert.deepEqual(b.seen.slice(0, 8).map((x) => [x.tool, x.input]), [
    ["planner.add", { text: "buy milk", kind: "todo" }], ["planner.done", { item: "t1" }], ["planner.update", { item: "t1", state: "open" }], ["planner.delete", { item: "t1" }],
    ["planner.delete", { item: "t1", restore: true }], ["planner.snooze", { firing: "f1" }], ["planner.parse", { text: "alarm 7am" }], ["planner.parse", { text: "x", kind: "event" }],
  ]);
});
