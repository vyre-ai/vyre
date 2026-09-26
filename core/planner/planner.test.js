// @ts-check
// The planner on a fake clock: the module started against an in-memory store and the real event
// log, with a hand-driven timer, so every ring is checked at the exact instant it is due. Callers
// are checked as the registry does (callerAllowed) and then inside each tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import planner, { seams } from "./index.js";
import { CAP_MS } from "./scheduler.js";
import { localParts } from "./time.js";
import { migrate } from "../store/index.js";
import { Events } from "../events/index.js";
import { callerAllowed } from "../modules/index.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const T0 = Z(2026, 9, 24, 5); // Thursday 10:00 in Karachi
let homes = 0;

/**
 * A planner on a fake clock. `boot()` starts (or restarts, after downtime) the module on the same
 * store; `advance(ms)` runs every timer that falls due on the way, in order.
 */
async function world(t, { role = "box", tz = "Asia/Karachi", linked = false, remote = null, start = T0 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(db);
  const root = `/planner-test-${++homes}`;
  const clock = { t: start };
  /** @type {Map<number, { at: number, ms: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
  t.after(() => seams.delete(root));
  const logs = [], fired = [], acked = [];
  events.on("planner.fired", e => fired.push({ at: clock.t, ...e.payload }));
  events.on("planner.acked", e => acked.push(e.payload));
  const w = {
    db, events, clock, timers, logs, fired, acked, linked, remote, handle: /** @type {any} */ (null),
    /** @type {Map<string, any>} */ tools: new Map(),
    async boot() {
      w.tools = new Map();
      const ctx = {
        name: "planner", config: { role, planner: { timezone: tz } }, paths: { root },
        store: { db, migrate: steps => migrate(db, "planner", steps) },
        log: m => logs.push(m),
        events: { emit: (type, p, where) => events.emit("planner", type, p, where), on: (p, fn) => events.on(p, fn) },
        tool: (name, def) => w.tools.set(name, def),
        call: async tool => tool === "link.status" ? { data: { linked: w.linked } } : { error: { code: "no_such_tool", message: "no" } },
        remote: async (tool, input) => w.remote ? w.remote(tool, input) : { error: { code: "no_link", message: "no link" } },
      };
      w.handle = await planner.start(ctx);
      t.after(() => w.handle.stop());
      return w;
    },
    async stop() { await w.handle.stop(); },
    /** A call as the registry makes it: the callers list first, then the tool. */
    async call(name, input = {}, caller = "cli") {
      const def = w.tools.get(name);
      if (!def) return { error: { code: "no_such_tool" } };
      if (!callerAllowed(def.callers, caller)) return { error: { code: "denied", message: `${name} is not for ${caller}` } };
      try { return { data: await def.run(input, { caller }) }; }
      catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code || "failed", message: err.message } }; }
    },
    async ok(name, input = {}, caller = "cli") {
      const r = await w.call(name, input, caller);
      assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`);
      return r.data;
    },
    /** Move the clock on, running each timer as its moment comes. */
    advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
      }
      clock.t = end;
    },
    advanceTo(at) { w.advance(at - clock.t); },
  };
  return w.boot();
}

test("planner: a one-off alarm rings at its instant, and not before", async t => {
  const w = await world(t);
  const a = await w.ok("planner.add", { kind: "alarm", title: "Northwind Bakery delivery", wall: "07:00" });
  assert.equal(a.at, Z(2026, 9, 25, 2), "07:00 tomorrow in Karachi");
  assert.equal(a.floating, true, "alarms follow the zone by default");
  w.advanceTo(a.at - 1000);
  assert.equal(w.fired.length, 0);
  w.advanceTo(a.at);
  assert.equal(w.fired.length, 1);
  assert.deepEqual({ ...w.fired[0], firing: "x" }, { at: a.at, firing: "x", item: a.id, kind: "alarm", title: "Northwind Bakery delivery", due: a.at,
    ring: 1, missed: false, actions: ["done", "snooze"] });
  assert.match((await w.call("planner.add", { kind: "alarm", at: new Date(T0 - HOUR).toISOString() })).error.message, /already passed/);
});

test("planner: a daily 07:00 alarm rings at 07:00 New York time on both sides of the change", async t => {
  const w = await world(t, { tz: "America/New_York", start: Z(2026, 3, 5, 17) });
  await w.ok("planner.settings", { escalate_max: 0 });
  const a = await w.ok("planner.add", { kind: "alarm", title: "Wake", wall: "07:00", repeat: { every: "day" } });
  for (let i = 0; i < 5; i++) {
    const before = w.fired.length;
    w.advance(DAY);
    const f = w.fired[before];
    assert.ok(f, `day ${i}`);
    const p = localParts(f.at, "America/New_York");
    assert.equal(`${p.hour}:${p.minute}`, "7:0", new Date(f.at).toISOString());
    await w.ok("planner.done", { firing: f.firing });
  }
  assert.deepEqual(w.fired.map(f => new Date(f.at).toISOString()), ["2026-03-06T12:00:00.000Z", "2026-03-07T12:00:00.000Z",
    "2026-03-08T11:00:00.000Z", "2026-03-09T11:00:00.000Z", "2026-03-10T11:00:00.000Z"]);
  const item = (await w.ok("planner.get", { item: a.id })).item;
  assert.equal(item.state, "open", "a repeating alarm keeps going when acknowledged");
  assert.equal(item.next_fire, Z(2026, 3, 11, 11));
});

test("planner: a floating alarm follows a zone change; a fixed reminder stays", async t => {
  const w = await world(t);
  const alarm = await w.ok("planner.add", { kind: "alarm", title: "Gym", wall: "07:00", date: "2026-09-25" });
  const rem = await w.ok("planner.add", { kind: "reminder", title: "Call Harlow Legal", wall: "09:00", date: "2026-09-25" });
  assert.equal(rem.floating, false);
  assert.equal(rem.tz, "Asia/Karachi");
  const s = await w.ok("planner.settings", { timezone: "Europe/London" });
  assert.equal(s.timezone, "Europe/London");
  const moved = (await w.ok("planner.get", { item: alarm.id })).item;
  assert.equal(moved.next_fire, Z(2026, 9, 25, 6), "07:00 BST");
  assert.equal((await w.ok("planner.get", { item: rem.id })).item.next_fire, Z(2026, 9, 25, 4), "09:00 in Karachi still");
  w.advanceTo(Z(2026, 9, 25, 2, 30));
  assert.deepEqual(w.fired.map(f => f.item), [], "nothing at 07:00 Karachi");
  w.advanceTo(Z(2026, 9, 25, 6));
  assert.deepEqual(w.fired.filter(f => f.ring === 1).map(f => f.item), [rem.id, alarm.id]);
});

test("planner: a snoozed reminder rings again after the snooze, as a new firing", async t => {
  const w = await world(t);
  const r = await w.ok("planner.add", { kind: "reminder", title: "Send kit the invoice", at: new Date(T0 + 30 * MIN).toISOString() });
  w.advance(30 * MIN);
  const first = w.fired[0];
  assert.equal(first.at, T0 + 30 * MIN);
  const s = await w.ok("planner.snooze", { firing: first.firing });
  assert.equal(s.until, T0 + 39 * MIN, "nine minutes by default");
  assert.deepEqual(w.acked, [{ firing: first.firing, item: r.id, action: "snooze", by: "cli", until: T0 + 39 * MIN }]);
  w.advance(9 * MIN - 1000);
  assert.equal(w.fired.length, 1, "no escalation while snoozed");
  w.advance(1000);
  assert.equal(w.fired.length, 2);
  assert.notEqual(w.fired[1].firing, first.firing);
  assert.equal(w.fired[1].ring, 1);
  assert.equal((await w.ok("planner.snooze", { firing: first.firing })).already, true, "the first acknowledgement wins");
  await w.ok("planner.dismiss", { firing: w.fired[1].firing });
  assert.equal((await w.ok("planner.get", { item: r.id })).item.state, "done", "a dismissed one-off reminder is over");
});

test("planner: a todo rings once when due; a timer rings when it runs out", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_max: 0 });
  const todo = await w.ok("planner.add", { kind: "todo", title: "File Northwind Bakery's return", due: "2026-09-24T18:00:00+05:00", list: "work", priority: 2 });
  assert.equal(todo.due, "2026-09-24");
  const undated = await w.ok("planner.add", { kind: "todo", title: "Buy flour", due: "2026-09-26" });
  assert.equal(undated.next_fire, null, "a todo due on a day rings on no hour");
  const timer = await w.ok("planner.add", { kind: "timer", in_ms: 10 * MIN });
  assert.equal(timer.title, "Timer");
  w.advance(10 * MIN);
  assert.deepEqual(w.fired.map(f => [f.kind, f.at]), [["timer", T0 + 10 * MIN]]);
  w.advance(3 * DAY);
  assert.deepEqual(w.fired.map(f => [f.kind, f.at]), [["timer", T0 + 10 * MIN], ["todo", Z(2026, 9, 24, 13)]], "the todo rang once");
  assert.equal((await w.ok("planner.get", { item: todo.id })).item.state, "open", "rung, still to do");
  await w.ok("planner.done", { item: todo.id });
  assert.equal((await w.ok("planner.get", { item: todo.id })).item.state, "done");
  const agenda = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-30" });
  assert.deepEqual(agenda.todos.map(x => x.title), ["Buy flour"]);
});

test("planner: an unacknowledged alarm rings escalate_max more times, then stops; an ack stops it at once", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_after: 5, escalate_max: 3 });
  const a = await w.ok("planner.add", { kind: "alarm", at: T0 + MIN });
  w.advance(MIN);
  w.advance(2 * HOUR);
  assert.deepEqual(w.fired.filter(f => f.item === a.id).map(f => [f.ring, f.at - T0]), [[1, MIN], [2, 6 * MIN], [3, 11 * MIN], [4, 16 * MIN]]);
  assert.equal(new Set(w.fired.map(f => f.firing)).size, 1, "one firing, rung again");

  const b = await w.ok("planner.add", { kind: "alarm", at: w.clock.t + MIN });
  w.advance(MIN);
  const fb = w.fired.at(-1);
  assert.equal(fb.item, b.id);
  const r = await w.ok("planner.done", { firing: fb.firing }, "capsule");
  assert.equal(r.firing.state, "acked");
  assert.deepEqual(w.acked.at(-1), { firing: fb.firing, item: b.id, action: "done", by: "capsule" });
  w.advance(HOUR);
  assert.equal(w.fired.filter(f => f.item === b.id).length, 1, "no ring after the ack");
  assert.equal((await w.ok("planner.get", { item: b.id })).item.state, "done");
});

test("planner: after downtime, what fell due rings once, marked missed; a day stale is kept without ringing", async t => {
  const w = await world(t);
  const daily = await w.ok("planner.add", { kind: "alarm", title: "Meds", wall: "07:00", repeat: { every: "day" } });
  const soon = await w.ok("planner.add", { kind: "reminder", title: "Call juno", at: new Date(T0 + HOUR).toISOString() });
  const old = await w.ok("planner.add", { kind: "reminder", title: "Pay rent", at: new Date(T0 + 2 * HOUR).toISOString() });
  await w.stop();
  // Down from Thursday 10:00 until Sunday 08:00 in Karachi.
  w.clock.t = Z(2026, 9, 27, 3);
  w.timers.clear();
  await w.boot();
  const got = w.fired.map(f => [f.item, f.missed, new Date(f.due).toISOString()]);
  assert.deepEqual(got, [[daily.id, true, "2026-09-27T02:00:00.000Z"]], "one ring for the daily alarm, for this morning's 07:00");
  const firings = id => w.db.prepare("SELECT state, missed, ring FROM planner_firings WHERE item = ?").all(id).map(r => ({ ...r }));
  assert.deepEqual(firings(soon.id), [{ state: "missed", missed: 1, ring: 0 }]);
  assert.deepEqual(firings(old.id), [{ state: "missed", missed: 1, ring: 0 }]);
  assert.equal((await w.ok("planner.get", { item: daily.id })).item.next_fire, Z(2026, 9, 28, 2));

  // Down for two hours only: that rings, marked missed.
  const r = await w.ok("planner.add", { kind: "reminder", title: "Northwind order", at: new Date(w.clock.t + HOUR).toISOString() });
  await w.stop();
  w.clock.t += 3 * HOUR;
  w.timers.clear();
  await w.boot();
  assert.deepEqual(w.fired.filter(f => f.item === r.id).map(f => f.missed), [true]);
});

test("planner: one timer, at most six hours out, none when nothing is due, and a clock jump is noticed", async t => {
  const w = await world(t);
  assert.equal(w.timers.size, 0, "nothing due, no timer");
  await w.ok("planner.add", { kind: "note", title: "Harlow Legal intake questions", body: "- conflicts\n- fees", tags: ["harlow"], pinned: true });
  await w.ok("planner.add", { kind: "todo", title: "Someday" });
  assert.equal(w.timers.size, 0, "notes and undated todos need no timer");
  const far = await w.ok("planner.add", { kind: "reminder", title: "Renew the domain", at: new Date(T0 + 3 * DAY).toISOString() });
  assert.equal(w.timers.size, 1);
  assert.equal([...w.timers.values()][0].ms, CAP_MS, "capped at six hours");
  w.advance(CAP_MS);
  assert.equal(w.timers.size, 1, "re-armed after the cap");
  assert.ok([...w.timers.values()].every(x => x.ms <= CAP_MS && x.ms >= 1000));
  // The clock jumps an hour past what the timer expected.
  const [id, x] = [...w.timers.entries()][0];
  w.timers.delete(id);
  w.clock.t = x.at + HOUR;
  x.fn();
  assert.ok(w.logs.some(l => /clock moved 3600 s/.test(l)), w.logs.join("\n"));
  await w.ok("planner.delete", { item: far.id });
  assert.equal(w.timers.size, 0, "deleted, nothing left to wait for");
  assert.equal((await w.ok("planner.list", { pinned: true })).length, 1);
  assert.deepEqual((await w.ok("planner.list", { tag: "harlow" })).map(n => n.body), ["- conflicts\n- fees"]);
  const back = await w.ok("planner.delete", { item: far.id, restore: true });
  assert.equal(back.deleted_at, null);
  assert.equal(w.timers.size, 1);
});

test("planner: an agent may add and finish a todo, reminder or note, never an alarm, and never snooze", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  assert.equal((await w.call("planner.add", { kind: "alarm", wall: "07:00" }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.add", { kind: "timer", in_ms: MIN }, "module:watchers")).error.code, "denied");
  const todo = await w.ok("planner.add", { kind: "todo", title: "Draft the Northwind Bakery proposal", project: "northwind" }, kit);
  assert.equal(todo.source, "mcp");
  await w.ok("planner.add", { kind: "note", title: "juno prefers mornings" }, kit);
  await w.ok("planner.update", { item: todo.id, priority: 3 }, kit);
  await w.ok("planner.done", { item: todo.id }, kit);
  const alarm = await w.ok("planner.add", { kind: "alarm", wall: "07:00" });
  assert.equal((await w.call("planner.update", { item: alarm.id, title: "x" }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.done", { item: alarm.id }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.snooze", { item: todo.id }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.settings", {}, kit)).error.code, "denied");
  assert.equal((await w.call("planner.delete", { item: todo.id }, kit)).error.code, "denied");
  assert.ok((await w.ok("planner.list", {}, kit)).length >= 1, "agents read");
  assert.ok((await w.ok("planner.agenda", {}, kit)).entries.length >= 0);
  // The owner's own Deck over the tailnet is a person.
  assert.ok(!(await w.call("planner.add", { kind: "alarm", wall: "08:00" }, "tailnet:alex")).error);
});

test("planner: a paired Mac forwards to the box and keeps its timer idle; an unpaired Mac runs alone", async t => {
  const sent = [];
  const box = async (tool, input) => {
    sent.push([tool, input]);
    if (tool === "planner.parse") return { data: { kind: "alarm", title: "Alarm", wall: "07:00" } };
    if (tool === "planner.get") return { data: { item: { kind: "alarm" } } };
    return { data: { id: "i_box", kind: input.kind } };
  };
  const mac = await world(t, { role: "local", linked: true, remote: box });
  assert.deepEqual(await mac.ok("planner.add", { kind: "reminder", title: "Call kit", wall: "18:00" }), { id: "i_box", kind: "reminder" });
  assert.deepEqual(sent, [["planner.add", { kind: "reminder", title: "Call kit", wall: "18:00" }]]);
  assert.equal(mac.db.prepare("SELECT COUNT(*) AS n FROM planner_items").get().n, 0, "nothing kept on the Mac");
  assert.equal(mac.timers.size, 0, "the Mac's scheduler is idle");
  // An agent on the Mac is held to its limits here: the box sees the forwarded call as the owner.
  assert.equal((await mac.call("planner.add", { text: "alarm 7am" }, "mcp:agent:kit")).error.code, "denied");
  assert.equal((await mac.call("planner.done", { item: "i_box" }, "mcp")).error.code, "denied");
  assert.deepEqual(sent.map(s => s[0]), ["planner.add", "planner.parse", "planner.get"], "the agent's add never reached the box");
  mac.remote = async () => ({ error: { code: "box_unreachable", message: "away" } });
  assert.deepEqual((await mac.call("planner.list", {})).error.code, "box_unreachable");

  const alone = await world(t, { role: "local", linked: false });
  const a = await alone.ok("planner.add", { kind: "alarm", wall: "07:00" });
  assert.equal(a.kind, "alarm");
  assert.equal(alone.timers.size, 1, "an unpaired Mac rings itself");
});

test("planner: words become items through parse.js, when it is there", async t => {
  const w = await world(t);
  const p = await w.ok("planner.parse", { text: "timer 10 min" });
  if (p === null) return t.skip("parse.js is not in this tree");
  assert.equal(p.kind, "timer");
  const timer = await w.ok("planner.add", { text: "timer 10 min" });
  assert.equal(timer.kind, "timer");
  assert.equal(timer.at, T0 + 10 * MIN);
  const alarm = await w.ok("planner.add", { text: "alarm 7am" });
  assert.deepEqual([alarm.kind, alarm.at], ["alarm", Z(2026, 9, 25, 2)]);
  const rem = await w.ok("planner.add", { text: "remind me to call the printer at 6" });
  assert.equal(rem.kind, "reminder");
  assert.equal(localParts(rem.at, "Asia/Karachi").hour, 18);
  assert.equal((await w.call("planner.add", { text: "alarm 7am" }, "mcp")).error.code, "denied", "parsed as an alarm, so not for an agent");
  const note = await w.ok("planner.add", { text: "juno's bakery order is 40 rolls", kind: "note" }, "mcp");
  assert.equal(note.kind, "note");
});
