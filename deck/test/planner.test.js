// @ts-check
// Planner (deck/views/planner.js) rendered into a fake DOM (fake-dom.js) with a fake api.js
// attempt() answering from the sample data below. Checks the four sections, the add box, the
// todo check, the fired banner and its Done and Snooze, the /planner/<firing> focus card, and
// that events redraw only while the page is visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

install();
const { drawPlanner, nextAlarms, sortNotes, repeatWord, CHANGES } = await import("../views/planner.js");

const T = Date.UTC(2026, 8, 27, 12, 0);
const item = (/** @type {any} */ o) => ({ title: "", body: null, pinned: false, state: "open", repeat: null, at: null, next_fire: null, snooze_until: null,
  due: null, updated: T, created: T, tags: [], ...o });
const ITEMS = [
  item({ id: "i_wake", kind: "alarm", title: "Wake up", next_fire: T + 19 * 3_600_000, repeat: { every: "weekday" } }),
  item({ id: "i_tea", kind: "timer", title: "Tea", next_fire: T + 5 * 60_000 }),
  item({ id: "i_old", kind: "alarm", title: "Old", state: "open", next_fire: null }),
  item({ id: "i_inv", kind: "todo", title: "Send the Northwind Bakery invoice", due: "2026-09-27" }),
  item({ id: "i_call", kind: "todo", title: "Call alex back", added_by: "kit" }),
  item({ id: "i_n1", kind: "note", title: "Printer codes", body: "Harlow Legal: 4471", updated: T - 1000 }),
  item({ id: "i_n2", kind: "note", title: "Pinned plan", pinned: true, updated: T - 9000 }),
];
const AGENDA = { tz: "Europe/London", from: T - 43_200_000, to: T + 43_200_000,
  entries: [
    { source: "planner", item: "i_tea", kind: "timer", title: "Tea", at: T + 5 * 60_000, end: null },
    { source: "calendar", account: "alex", event: "e1", kind: "event", title: "Harlow Legal weekly", at: T + 3_600_000, end: T + 5_400_000, all_day: false },
  ],
  todos: [ITEMS[3]] };

function fakeApi(/** @type {Record<string, any>} */ over = {}) {
  const calls = /** @type {{ tool: string, input: any }[]} */ ([]);
  const answers = /** @type {Record<string, any>} */ ({
    "planner.agenda": { data: AGENDA },
    "planner.list": { data: ITEMS },
    "planner.add": { data: item({ id: "i_new", kind: "alarm" }) },
    "planner.done": { data: { item: {}, firing: null } },
    "planner.snooze": { data: { item: {}, firing: null } },
    "planner.get": { data: { item: ITEMS[0], firings: [], firing: { id: "f_1", item: "i_wake", state: "ringing", due: T, ring: 1 } } },
    ...over,
  });
  const attempt = async (/** @type {string} */ tool, input = {}) => {
    calls.push({ tool, input: structuredClone(input) });
    const a = answers[tool];
    if (!a) return { error: { code: "no_such_tool", message: `no tool ${tool}`, module: "planner", missing: true } };
    return structuredClone(a);
  };
  return { attempt, calls, of: (/** @type {string} */ t) => calls.filter(c => c.tool === t) };
}

function fakeDoc() {
  const listeners = /** @type {Function[]} */ ([]);
  return { visibilityState: "visible", hidden: false,
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { if (t === "visibilitychange") listeners.push(fn); },
    removeEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    listeners, fire() { for (const f of [...listeners]) f(); } };
}

async function render(/** @type {any} */ o = {}) {
  const api = fakeApi(o.over);
  const doc = o.doc || fakeDoc();
  const el = document.createElement("div");
  const subs = /** @type {Map<string, Function[]>} */ (new Map());
  const cleanups = /** @type {Function[]} */ ([]);
  const ctx = { params: o.params || {}, alive: () => true, cleanup: (/** @type {Function} */ fn) => cleanups.push(fn),
    on: (/** @type {string} */ t, /** @type {Function} */ fn) => subs.set(t, [...(subs.get(t) || []), fn]) };
  await drawPlanner(/** @type {any} */ (el), ctx, { attempt: /** @type {any} */ (api.attempt), doc });
  const emit = (/** @type {string} */ type, /** @type {any} */ payload) => { for (const fn of subs.get(type) || []) fn({ type, payload }); };
  return { el, api, doc, subs, cleanups, emit };
}
const sec = (/** @type {any} */ el, /** @type {string} */ name) => $(el, `section[data-sec=${name}]`);
const settle = () => new Promise(r => setTimeout(r, 350));

test("helpers: next alarms soonest first, pinned notes first, repeat words", () => {
  assert.deepEqual(nextAlarms(ITEMS).map(i => i.id), ["i_tea", "i_wake"]);
  assert.deepEqual(sortNotes(ITEMS.filter(i => i.kind === "note")).map(i => i.id), ["i_n2", "i_n1"]);
  assert.equal(repeatWord({ every: "weekday" }), "Weekdays");
  assert.equal(repeatWord({ every: "day", interval: 2 }), "Every 2 days");
  assert.equal(repeatWord(null), "");
});

test("renders agenda, alarms, todos and notes from the tools", async () => {
  const { el, api } = await render();
  assert.deepEqual(api.of("planner.agenda").map(c => c.input), [{}]);
  assert.equal(api.of("planner.list").length, 1, "one list call feeds alarms, todos and notes");
  const agenda = text(sec(el, "agenda"));
  assert.match(agenda, /Tea/); assert.match(agenda, /Harlow Legal weekly/); assert.match(agenda, /Calendar/);
  assert.match(agenda, /Send the Northwind Bakery invoice/);
  const alarms = sec(el, "alarms");
  assert.deepEqual($$(alarms, ".pl-row").map((/** @type {any} */ r) => r.getAttribute("data-item")), ["i_tea", "i_wake"]);
  assert.match(text(alarms), /Weekdays/);
  assert.equal($$(sec(el, "todos"), "input[type=checkbox]").length, 2);
  assert.deepEqual($$(sec(el, "notes"), ".pl-note").map((/** @type {any} */ n) => n.getAttribute("data-item")), ["i_n2", "i_n1"]);
  assert.ok($(sec(el, "notes"), "[data-item=i_n2] .pl-pin"), "the pinned note shows a pin");
  assert.deepEqual($$(el, ".pl-from").map((/** @type {any} */ f) => text(f)), ["from kit"], "only an agent's item names who added it");
});

test("add by text calls planner.add { text } and redraws", async () => {
  const { el, api } = await render();
  const form = $(sec(el, "alarms"), "form");
  $(form, "input").value = "alarm 7am";
  await Promise.all(form.dispatchEvent(new Event("submit")));
  assert.deepEqual(api.of("planner.add").map(c => c.input), [{ text: "alarm 7am" }]);
  assert.equal(api.of("planner.list").length, 2);
});

test("an add error is shown and the text stays", async () => {
  const { el } = await render({ over: { "planner.add": { error: { code: "bad_input", message: "no time in that" } } } });
  const form = $(sec(el, "alarms"), "form");
  $(form, "input").value = "alarm whenever";
  await Promise.all(form.dispatchEvent(new Event("submit")));
  assert.match(text(sec(el, "alarms")), /no time in that/);
  assert.equal($(form, "input").value, "alarm whenever");
});

test("checking a todo calls planner.done { item } and removes the row", async () => {
  const { el, api } = await render();
  const box = $(sec(el, "todos"), "[data-item=i_call] input");
  await box.click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(api.of("planner.done").map(c => c.input), [{ item: "i_call" }]);
  assert.equal($(sec(el, "todos"), "[data-item=i_call]"), null);
});

test("planner.fired shows one banner per firing; Done and Snooze answer it; planner.acked removes it", async () => {
  const { el, api, emit } = await render();
  const fired = { firing: "f_1", item: "i_wake", kind: "alarm", title: "Wake up", due: T, ring: 1, missed: false, actions: ["done", "snooze"] };
  emit("planner.fired", fired);
  emit("planner.fired", { ...fired, ring: 2 });
  assert.equal($$(el, ".pl-banner").length, 1, "a second ring replaces the banner");
  assert.match(text($(el, ".pl-banner")), /ring 2/);
  await $(el, ".pl-banner [data-act=done]").click();
  assert.deepEqual(api.of("planner.done").map(c => c.input), [{ firing: "f_1" }]);
  assert.equal($$(el, ".pl-banner").length, 0);

  emit("planner.fired", { ...fired, firing: "f_2", added_by: "kit" });
  assert.match(text($(el, ".pl-banner")), /from kit/);
  await $(el, ".pl-banner [data-act=snooze]").click();
  assert.deepEqual(api.of("planner.snooze").map(c => c.input), [{ firing: "f_2" }]);

  emit("planner.fired", { ...fired, firing: "f_3" });
  emit("planner.acked", { firing: "f_3", item: "i_wake", action: "done", by: "capsule" });
  assert.equal($$(el, ".pl-banner").length, 0, "acknowledged elsewhere, the banner goes");
});

test("/planner/<firing> opens the firing's item with Done and Snooze", async () => {
  const { el, api } = await render({ params: { firing: "f_1" } });
  assert.deepEqual(api.of("planner.get").map(c => c.input), [{ firing: "f_1" }]);
  const card = $(el, ".pl-focus .pl-card");
  assert.match(text(card), /Wake up/); assert.match(text(card), /ringing/);
  await $(card, "[data-act=snooze]").click();
  assert.deepEqual(api.of("planner.snooze").map(c => c.input), [{ firing: "f_1" }]);
});

test("a firing that is gone says so", async () => {
  const { el } = await render({ params: { firing: "f_gone" }, over: { "planner.get": { error: { code: "not_found", message: "no such item" } } } });
  assert.match(text($(el, ".pl-focus")), /not on the planner any more/);
});

test("events redraw only while visible; a hidden page redraws once when shown", async () => {
  const { api, doc, subs, emit, cleanups } = await render();
  for (const t of [...CHANGES, "planner.fired"]) assert.ok(subs.has(t), `listens to ${t}`);
  assert.ok(![...subs.keys()].some(t => t.includes("*")), "named events only");
  emit("planner.changed", { item: "i_call", kind: "todo", fields: ["title"] });
  emit("planner.added", { item: "i_x", kind: "note" });
  await settle();
  assert.equal(api.of("planner.list").length, 2, "two events, one debounced redraw");

  doc.visibilityState = "hidden"; doc.hidden = true;
  emit("planner.removed", { item: "i_x", kind: "note" });
  await settle();
  assert.equal(api.of("planner.list").length, 2, "no redraw while hidden");
  doc.visibilityState = "visible"; doc.hidden = false;
  doc.fire();
  await settle();
  assert.equal(api.of("planner.list").length, 3, "one redraw on becoming visible");
  doc.fire();
  await settle();
  assert.equal(api.of("planner.list").length, 3, "nothing more without a change");

  for (const f of cleanups) f();
  assert.equal(doc.listeners.length, 0, "leaving the view drops the visibility listener");
});

test("the planner module not running shows it in plain words", async () => {
  const miss = { error: { code: "no_such_tool", message: "no tool", module: "planner", missing: true } };
  const { el } = await render({ over: { "planner.agenda": miss, "planner.list": miss } });
  assert.match(text(el), /The planner module is not running/);
});
