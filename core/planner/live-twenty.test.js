// @ts-check
// The planner on a real Twenty (the pinned v2.44.0), through the kernel's gateway: the starts_at range filter the planner reads events with, reminders and to-dos through the
// store's paging and updates, and a restart that reads everything back. Skipped unless VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE are set; it runs inside a container on the
// Space's internal network (stores/twenty/live/run-on-testbox.sh, or core/planner/live-twenty.sh), because Twenty has no published port.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTwentyStore } from "../../stores/twenty/store.js";
import { TwentyClient } from "../../stores/twenty/client.js";
import { PLANNER_TYPES } from "./types.js";
import { world, newKernel, prepareKernel, FACTS, T0, HOUR, DAY, MIN, iso } from "./testing.js";

const URL_ = process.env.VYRE_TWENTY_LIVE_URL, KEY_FILE = process.env.VYRE_TWENTY_LIVE_KEY_FILE;

if (!URL_ || !KEY_FILE) {
  test("planner on live Twenty (skipped: set VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE)", { skip: true }, () => {});
} else {
  const client = new TwentyClient({ url: URL_, key: () => fs.readFileSync(KEY_FILE, "utf8").trim() });
  /** One kernel over a fresh store of this Twenty, with the Event type and the assistants defined. */
  async function kernel() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-planner-"));
    const store = createTwentyStore({ client, space: "planner-live", dir, graceMs: 250 });
    const k = await newKernel(store);
    await prepareKernel(k);
    // The Twenty outlives a run: what an earlier one left is cleared, so this one reads only its own (the types are defined first so the store can be asked).
    await store.define({ add_types: PLANNER_TYPES });
    for (const type of ["reminder", "note", "planner_firing", "planner_state", "event"]) {
      for (;;) {
        const page = await store.query(type, { page: { limit: 100 } }).catch(() => ({ rows: [] }));
        if (!page.rows.length) break;
        for (const r of page.rows) await store.remove(type, r.id, r.version).catch(() => {});
      }
    }
    return k;
  }
  const noon = (/** @type {number} */ ms) => iso(ms);

  test("live: the starts_at range filter returns exactly the events in the window, in time order, and pages", { timeout: 300_000 }, async () => {
    const k = await kernel();
    const owner = k.chains.fromFacts(FACTS), R = k.gateway.records;
    const run = `r${Date.now()}`;
    const at = [-40 * DAY, -2 * DAY, -3 * HOUR, 0, 2 * HOUR, 5 * DAY, 13 * DAY, 15 * DAY, 30 * DAY];
    for (const [i, d] of at.entries()) await R.create(owner, "event", { title: `${run}:e${i}`, starts_at: noon(T0 + d), ends_at: noon(T0 + d + HOUR), all_day: false, source: "google", calendar: run, external_id: `x${i}` });
    const from = T0 - DAY, to = T0 + 14 * DAY;
    const mine = (/** @type {any[]} */ rows) => rows;
    const got = await R.query(owner, "event", { filter: { and: [{ field: "calendar", op: "eq", value: run }, { field: "starts_at", op: "lt", value: noon(to) }, { field: "starts_at", op: "gte", value: noon(from - 40 * DAY) }] }, page: { limit: 50 } });
    const inWindow = mine(got.rows).filter(r => Date.parse(r.data.starts_at) < to && Date.parse(r.data.starts_at) >= from).map(r => String(r.data.title).slice(run.length + 1)).sort();
    assert.deepEqual(inWindow, ["e2", "e3", "e4", "e5", "e6"], "the events the planner rings for");
    assert.ok(got.rows.every(r => Date.parse(r.data.starts_at) < to), "nothing past the upper bound");
    got.rows = mine(got.rows);
    assert.ok(!got.rows.some(r => [`${run}:e7`, `${run}:e8`].includes(r.data.title)), "15 and 30 days ahead are past the bound");
    // sorted ascending and paged
    const p1 = await R.query(owner, "event", { filter: { and: [{ field: "calendar", op: "eq", value: run }, { field: "starts_at", op: "gte", value: noon(T0 - 3 * DAY) }] }, sort: [{ field: "starts_at", dir: "asc" }], page: { limit: 3 } });
    assert.equal(p1.rows.length, 3);
    assert.ok(p1.next_cursor);
    const p2 = await R.query(owner, "event", { filter: { and: [{ field: "calendar", op: "eq", value: run }, { field: "starts_at", op: "gte", value: noon(T0 - 3 * DAY) }] }, sort: [{ field: "starts_at", dir: "asc" }], page: { limit: 50, cursor: p1.next_cursor } });
    const all = [...p1.rows, ...p2.rows].map(r => String(r.data.title).slice(run.length + 1));
    assert.deepEqual(all, ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], "ascending by start across pages");
    for (const r of [...p1.rows, ...p2.rows, ...got.rows]) await R.remove(owner, "event", r.id, r.version).catch(() => {});
  });

  test("live: reminders, a to-do and an event ring through a real Twenty, and a restart reads them back", { timeout: 300_000 }, async t => {
    const k = await kernel();
    const w = await world(t, { kernel: k });
    const r = await w.ok("planner.add", { kind: "reminder", title: "Call juno", at: iso(T0 + HOUR), list: "work" });
    const todo = await w.ok("planner.add", { kind: "todo", title: "Send the letter", list: "clients" });
    await w.ok("planner.update", { item: todo.id, title: "Send the Harlow Legal letter" });
    const ev = await k.gateway.records.create(w.owner, "event", { title: "Harlow Legal review", starts_at: noon(T0 + 3 * HOUR), ends_at: noon(T0 + 4 * HOUR), all_day: false, source: "google", calendar: "alex", external_id: "live1" });
    await w.read();
    await w.advance(HOUR);
    assert.deepEqual(w.fired.map(f => f.item), [r.id]);
    await w.ok("planner.done", { firing: w.fired[0].firing }).catch(e => { throw new Error(`${e.message} :: ${w.logs.join(" | ")}`); });
    await w.advance(2 * HOUR - 10 * MIN);
    assert.deepEqual(w.fired.slice(1).map(f => f.item), [ev.id], "the event rings event_lead before its start");
    await w.ok("planner.done", { item: todo.id });
    assert.equal((await k.tasks.get(w.owner, todo.id)).state, "done");
    await w.handle.stop();
    const w2 = await world(t, { kernel: k, start: w.clock.t });
    const list = await w2.ok("planner.list", { state: "all" });
    assert.deepEqual(list.map(x => x.title).sort(), ["Call juno", "Send the Harlow Legal letter"]);
    assert.equal(list.find(x => x.id === todo.id).state, "done");
    await k.gateway.records.remove(w.owner, "event", ev.id, (await k.gateway.records.get(w.owner, "event", ev.id)).version).catch(() => {});
  });
  test("live: an event's rrule and url round-trip through a real Twenty: create, list, update, clear with null, remove into the bin, list the bin, restore, and the planner expands the repeat", { timeout: 300_000 }, async t => {
    const k = await kernel();
    const w = await world(t, { kernel: k });
    const R = k.gateway.records, run = `r${Date.now()}`;
    const rule = "FREQ=WEEKLY;BYDAY=MO;COUNT=4", link = "https://calendar.example.com/e/abc?x=1&y=2";
    const ev = await R.create(w.owner, "event", { title: `${run} Retro`, starts_at: noon(T0 + 2 * HOUR), ends_at: noon(T0 + 3 * HOUR), all_day: false, source: "vyre", rrule: rule, url: link });
    const listed = async (/** @type {any} */ extra = {}) => (await R.query(w.owner, "event", { filter: { field: "title", op: "eq", value: `${run} Retro` }, page: { limit: 10 }, ...extra })).rows;
    const [row0] = await listed();
    assert.deepEqual([row0.id, row0.data.rrule, row0.data.url], [ev.id, rule, link], "rrule and url come back exactly as written");
    // the planner is running over this Space and may write the event too, so each write names the version read just before it
    const ver = async () => (await R.get(w.owner, "event", ev.id)).version;
    let row = await R.update(w.owner, "event", ev.id, { rrule: "FREQ=DAILY;COUNT=2" }, await ver());
    assert.equal((await listed())[0].data.rrule, "FREQ=DAILY;COUNT=2", "an update changes the rule");
    row = await R.update(w.owner, "event", ev.id, { rrule: null, url: null }, await ver());
    const cleared = (await listed())[0].data;
    assert.ok(cleared.rrule == null && cleared.url == null, "null clears both");
    row = await R.update(w.owner, "event", ev.id, { rrule: rule, url: link }, await ver());
    await R.remove(w.owner, "event", ev.id, await ver());
    assert.equal((await listed()).length, 0, "a removed event is not in the list");
    const bin = await listed({ include_deleted: true });
    assert.deepEqual(bin.map((/** @type {any} */ x) => [x.id, x.deleted_at > 0, x.data.rrule, x.data.url]), [[ev.id, true, rule, link]], "the bin lists it with its fields");
    await R.restore(w.owner, "event", ev.id);
    const back = (await listed())[0];
    assert.deepEqual([back.id, back.data.rrule, back.data.url, back.deleted_at ?? null], [ev.id, rule, link, null], "restored with both fields");
    await w.read();
    const upcoming = await w.ok("planner.agenda", { from: noon(T0), to: noon(T0 + 30 * DAY) });
    assert.equal(JSON.stringify(upcoming).split(`${run} Retro`).length - 1 >= 2, true, "the planner expands the repeat into more than one occurrence");
    await R.remove(w.owner, "event", ev.id, await ver()).catch(() => {});
  });
}
