// @ts-check
// The planner on a fake clock: the module started against an in-memory store and the real event
// log, with a hand-driven timer, so every ring is checked at the exact instant it is due. Callers
// are checked as the registry does (callerAllowed) and then inside each tool.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import planner, { seams } from "./index.js";
import { CAP_MS } from "./scheduler.js";
import { localParts } from "./time.js";
import { migrate } from "../store/index.js";
import fs from "node:fs";
import { createKernel } from "../../kernel/index.js";
import { Events } from "../events/index.js";
import { callerAllowed } from "../modules/index.js";
import { isPerson } from "../../lib/caller.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const T0 = Z(2026, 9, 24, 5); // Thursday 10:00 in Karachi
let homes = 0;
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const NEEDS = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs;
/** The person's own call into the kernel, for the acts only a person does (finishing a todo). */
export const PERSON = { kind: "device", device_key_id: "d", person: OWNER, path: "direct" };

/**
 * A planner on a fake clock. `boot()` starts (or restarts, after downtime) the module on the same
 * store; `advance(ms)` runs every timer that falls due on the way, in order.
 */
async function world(t, { role = "box", tz = "Asia/Karachi", linked = false, remote = null, start = T0, kernel = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(db);
  const k = kernel ? await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4) }) : null;
  const root = `/planner-test-${++homes}`;
  const clock = { t: start };
  /** @type {Map<number, { at: number, ms: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
  t.after(() => seams.delete(root));
  const logs = [], fired = [], acked = [], taskRuns = [], calls = [];
  // Default agent roster for agents.list: juno is the assistant (sees every project); kit is a
  // named agent scoped to every project too, by default, so existing tests that never touch scope
  // keep passing - taskScope tests below narrow kit's (or a second agent's) projects explicitly.
  events.on("planner.fired", e => fired.push({ at: clock.t, ...e.payload }));
  events.on("planner.acked", e => acked.push(e.payload));
  events.on("planner.task-run", e => taskRuns.push(e.payload));
  const w = {
    db, events, clock, timers, logs, fired, acked, taskRuns, calls, linked, remote, handle: /** @type {any} */ (null), k,
    agents: [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent", projects: "*" }],
    /** @type {(tool: string, input: any) => Promise<any>|any} */ onCall: null,
    /** @type {Map<string, any>} */ tools: new Map(),
    async boot() {
      w.tools = new Map();
      const ctx = {
        name: "planner", config: { role, planner: { timezone: tz } }, paths: { root },
        store: { db, migrate: steps => migrate(db, "planner", steps) },
        ...(k ? { kernel: k.kernelFor({ name: "planner", needs: NEEDS }) } : {}),
        log: m => logs.push(m),
        events: { emit: (type, p, where) => events.emit("planner", type, p, where), on: (p, fn) => events.on(p, fn), latestId: () => events.latestId() },
        tool: (name, def) => w.tools.set(name, def),
        // No Google account connected: the calendar slice stays asleep (core/planner/calendar.test.js covers it).
        call: async (tool, input) => {
          calls.push({ tool, input });
          if (tool === "link.status") return { data: { linked: w.linked } };
          if (tool === "google.accounts") return { data: [] };
          // juno is the user's assistant; kit is an agent they made (w.agents: tests narrow it).
          if (tool === "agents.list") return { data: w.agents };
          // /later's own firing (runTask): a test sets w.onCall to answer threads.post/launch
          // its own way; the default is a plain success, so tests that never touch this still see
          // nothing different.
          if (tool === "threads.post" || tool === "threads.launch" || tool === "agents.job") return w.onCall ? await w.onCall(tool, input) : { data: { ok: true } };
          return { error: { code: "no_such_tool", message: "no" } };
        },
        remote: async (tool, input) => w.remote ? w.remote(tool, input) : { error: { code: "no_link", message: "no link" } },
      };
      w.handle = await planner.start(ctx);
      t.after(() => w.handle.stop());
      return w;
    },
    async stop() { await w.handle.stop(); },
    /** A call as the registry makes it: the callers list first, then the tool. `meta` extends
     * `{caller}` - `{thread}` is the one other field the planner's tools read (the caller's own
     * calling thread, for taskScope). */
    async call(name, input = {}, caller = "cli", meta = {}) {
      const def = w.tools.get(name);
      if (!def) return { error: { code: "no_such_tool" } };
      if (!callerAllowed(def.callers, caller)) return { error: { code: "denied", message: `${name} is not for ${caller}` } };
      try { return { data: await def.run(input, { caller, ...(isPerson(caller) ? { kernelFacts: PERSON } : {}), ...meta }) }; }
      catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code || "failed", message: err.message } }; }
    },
    async ok(name, input = {}, caller = "cli", meta = {}) {
      const r = await w.call(name, input, caller, meta);
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
  assert.deepEqual({ ...w.fired[0], firing: "x" }, { at: a.at, firing: "x", key: `planner-${a.id}-${a.at / 1000}`, item: a.id, kind: "alarm", title: "Northwind Bakery delivery", due: a.at,
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
  assert.deepEqual(w.acked, [{ firing: first.firing, key: `planner-${r.id}-${(T0 + 30 * MIN) / 1000}`, item: r.id, due: T0 + 30 * MIN, action: "snooze", by: "cli", until: T0 + 39 * MIN }]);
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

test("planner: a todo is a task in the Space, done by the person, and rings nothing; a timer rings when it runs out", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_max: 0 });
  const todo = await w.ok("planner.add", { kind: "todo", title: "File Northwind Bakery's return", due: "2026-09-24T18:00:00+05:00", list: "work", priority: 2 });
  assert.equal(todo.due, "2026-09-24");
  assert.deepEqual([todo.list, todo.priority], ["work", 2], "what the planner knew of it rides with the task");
  assert.match(todo.id, /^[0-9a-f]{8}-/, "its id is the task's");
  const task = await w.k.tasks.get(w.k.chains.fromFacts(PERSON), todo.id);
  assert.deepEqual([task.title, task.doer.id, task.output.kind], ["File Northwind Bakery's return", OWNER, "note"], "a kernel task, the person the doer");
  const undated = await w.ok("planner.add", { kind: "todo", title: "Buy flour", due: "2026-09-26" });
  assert.equal(undated.next_fire, null, "a todo due on a day rings on no hour");
  const timer = await w.ok("planner.add", { kind: "timer", in_ms: 10 * MIN });
  assert.equal(timer.title, "Timer");
  w.advance(10 * MIN);
  assert.deepEqual(w.fired.map(f => [f.kind, f.at]), [["timer", T0 + 10 * MIN]]);
  w.advance(3 * DAY);
  assert.deepEqual(w.fired.map(f => [f.kind, f.at]), [["timer", T0 + 10 * MIN]], "a todo rings nothing");
  assert.equal((await w.ok("planner.get", { item: todo.id })).item.state, "open");
  await w.ok("planner.done", { item: todo.id });
  assert.equal((await w.ok("planner.get", { item: todo.id })).item.state, "done");
  assert.equal((await w.k.tasks.get(w.k.chains.fromFacts(PERSON), todo.id)).state, "done", "the task is done in the kernel");
  const agenda = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-30" });
  assert.deepEqual(agenda.todos.map(x => x.title), ["Buy flour"]);
  // Dropping one skips the task; it does not come back. A todo does not repeat and its words do not change.
  await w.ok("planner.delete", { item: undated.id });
  assert.equal((await w.ok("planner.get", { item: undated.id })).item.state, "cancelled");
  assert.equal((await w.call("planner.delete", { item: undated.id, restore: true })).error.code, "bad_input");
  assert.equal((await w.call("planner.add", { kind: "todo", title: "x", wall: "09:00", repeat: { every: "day" } })).error.code, "bad_input");
  const other = await w.ok("planner.add", { kind: "todo", title: "Fix me" });
  assert.equal((await w.call("planner.update", { item: other.id, priority: 3 })).error.code, "bad_input");
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
  const ringing = await w.ok("planner.ringing", {});
  assert.ok(ringing.some(x => x.firing === fb.firing && x.item === b.id && x.kind === "alarm"), "a late surface sees what rings");
  const r = await w.ok("planner.done", { firing: fb.firing }, "capsule");
  assert.equal(r.firing.state, "acked");
  assert.deepEqual(w.acked.at(-1), { firing: fb.firing, key: `planner-${b.id}-${fb.due / 1000}`, item: b.id, due: fb.due, action: "done", by: "capsule" });
  w.advance(HOUR);
  assert.equal(w.fired.filter(f => f.item === b.id).length, 1, "no ring after the ack");
  assert.ok(!(await w.ok("planner.ringing", {})).some(x => x.firing === fb.firing), "an acked firing is not ringing");
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
  const firings = async id => (await w.ok("planner.get", { item: id })).firings.map(f => ({ state: f.state, missed: f.missed ? 1 : 0, ring: f.ring }));
  assert.deepEqual(await firings(soon.id), [{ state: "missed", missed: 1, ring: 0 }]);
  assert.deepEqual(await firings(old.id), [{ state: "missed", missed: 1, ring: 0 }]);
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

test("planner: anyone adds alarms, reminders, todos and notes; an agent changes only its own", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  // No prompt and no permission for any of these, agents included.
  const alarm = await w.ok("planner.add", { kind: "alarm", title: "Northwind Bakery delivery", wall: "07:00" }, kit);
  assert.deepEqual([alarm.source, alarm.added_by], ["agent:kit", "kit"], "an agent's item shows its name");
  const timer = await w.ok("planner.add", { kind: "timer", in_ms: MIN }, "module:watchers");
  assert.deepEqual([timer.source, timer.added_by], ["module:watchers", null]);
  const todo = await w.ok("planner.add", { kind: "todo", title: "Draft the Northwind Bakery proposal", project: "northwind" }, kit);
  const mine = await w.ok("planner.add", { kind: "note", title: "juno prefers mornings" }, "mcp:agent:juno");
  assert.deepEqual([mine.source, mine.added_by], ["agent:juno", null], "the assistant's items show no source");
  const session = await w.ok("planner.add", { kind: "reminder", title: "Call kit", wall: "18:00" }, "mcp");
  assert.deepEqual([session.source, session.added_by], ["mcp", null], "the person's own session shows no source");
  const person = await w.ok("planner.add", { kind: "alarm", wall: "06:00" });
  assert.deepEqual([person.source, person.added_by], ["cli", null]);
  assert.equal(w.events.since(0, { type: "planner.added" }).find(e => e.payload.item === alarm.id).payload.added_by, "kit");
  assert.equal((await w.call("planner.add", { kind: "event", title: "x", at: T0 + HOUR }, kit)).error.code, "denied", "an event is an invite");

  // kit edits, snoozes, finishes and deletes what kit added.
  assert.equal((await w.call("planner.update", { item: todo.id, priority: 3 }, kit)).error.code, "bad_input", "a todo's words do not change");
  await w.ok("planner.snooze", { item: alarm.id, minutes: 5 }, kit);
  assert.equal((await w.call("planner.done", { item: todo.id }, kit)).error.code, "denied", "a todo is done by a person");
  await w.ok("planner.delete", { item: alarm.id }, kit);
  await w.ok("planner.delete", { item: alarm.id, restore: true }, kit);
  // Nothing anyone else added: the person's, the assistant's, another module's.
  for (const item of [person, mine, timer]) {
    assert.equal((await w.call("planner.update", { item: item.id, title: "x" }, kit)).error.code, "denied");
    assert.equal((await w.call("planner.done", { item: item.id }, kit)).error.code, "denied");
    assert.equal((await w.call("planner.snooze", { item: item.id }, kit)).error.code, "denied");
    assert.equal((await w.call("planner.delete", { item: item.id }, kit)).error.code, "denied");
  }
  assert.equal((await w.call("planner.update", { item: todo.id, title: "x" }, "mcp:agent:juno")).error.code, "denied", "the assistant too");
  // The person changes anything, with no prompt, whoever added it.
  await w.ok("planner.update", { item: alarm.id, title: "Harlow Legal call" });
  await w.ok("planner.snooze", { item: mine.id, minutes: 10 }, "deck");
  await w.ok("planner.done", { item: todo.id }, "capsule");
  await w.ok("planner.delete", { item: timer.id }, "tailnet:alex");
  assert.equal((await w.call("planner.settings", {}, kit)).error.code, "denied");
  assert.ok((await w.ok("planner.list", {}, kit)).length >= 1, "agents read");
  assert.ok((await w.ok("planner.agenda", {}, kit)).entries.length >= 0);
});

test("planner: a runaway agent stops at the hour's cap, quietly, and starts again an hour later", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  for (let n = 0; n < 200; n++) await w.ok("planner.add", { kind: "note", title: `note ${n}` }, kit);
  const over = await w.call("planner.add", { kind: "note", title: "one more" }, kit);
  assert.equal(over.error.code, "busy");
  assert.ok(!(await w.call("planner.add", { kind: "note", title: "someone else" }, "mcp:agent:juno")).error, "per agent");
  assert.ok(!(await w.call("planner.add", { kind: "note", title: "the person" })).error, "never the person");
  w.advance(HOUR + 1);
  assert.ok(!(await w.call("planner.add", { kind: "note", title: "later" }, kit)).error);
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
  assert.equal((await mac.k.gateway.records.query(mac.k.chains.fromFacts(PERSON), "reminder", { page: { limit: 5 } })).rows.length, 0, "nothing kept on the Mac");
  assert.equal(mac.timers.size, 0, "the Mac's scheduler is idle");
  // The box sees a forwarded call as the owner, so an agent's call names the agent (as), and the
  // box holds it to the agent's rules. A person's call carries nothing, and nobody can forge as.
  await mac.ok("planner.add", { text: "alarm 7am" }, "mcp:agent:kit");
  await mac.ok("planner.done", { item: "i_box", as: { source: "cli" } }, "mcp");
  assert.deepEqual(sent.slice(1), [["planner.add", { text: "alarm 7am", as: { source: "agent:kit", name: "kit" } }],
    ["planner.done", { item: "i_box", as: { source: "mcp", name: null } }]]);
  // planner.parse answers on the Mac, never forwarded.
  assert.equal((await mac.ok("planner.parse", { text: "timer 10 min" })).kind, "timer");
  assert.equal(sent.length, 3, "the parse did not reach the box");

  // On the box, as from the owner's link applies the agent's rules.
  const onBox = await world(t);
  const item = await onBox.ok("planner.add", { kind: "note", title: "kit's", as: { source: "agent:kit", name: "kit" } }, "tailnet:alex");
  assert.deepEqual([item.source, item.added_by], ["agent:kit", "kit"]);
  const own = await onBox.ok("planner.add", { kind: "note", title: "alex's" });
  assert.equal((await onBox.call("planner.delete", { item: own.id, as: { source: "agent:kit", name: "kit" } }, "tailnet:alex")).error.code, "denied");
  await onBox.ok("planner.delete", { item: item.id, as: { source: "agent:kit", name: "kit" } }, "tailnet:alex");
  // An agent's own as is ignored: it stays itself.
  const forged = await onBox.ok("planner.add", { kind: "note", title: "x", as: { source: "cli" } }, "mcp:agent:kit");
  assert.equal(forged.source, "agent:kit");
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
  assert.equal((await w.ok("planner.add", { text: "alarm 7am" }, "mcp")).kind, "alarm", "an agent may set an alarm too");
  assert.equal((await w.call("planner.add", { text: "timer" })).error.code, "ambiguous", "words that cannot be placed say why");
  assert.equal((await w.ok("planner.add", { text: "10 min", kind: "timer" })).at, T0 + 10 * MIN, "kind is a hint to the parser");
  const note = await w.ok("planner.add", { text: "juno's bakery order is 40 rolls", kind: "note" }, "mcp");
  assert.equal(note.kind, "note");
});

test("planner: at in words is the next such time in the item's zone", async t => {
  const w = await world(t);
  const six = await w.ok("planner.add", { kind: "reminder", title: "Call Harlow Legal", at: "6pm" });
  assert.deepEqual([six.at, six.wall, six.date], [Z(2026, 9, 24, 13), "18:00", "2026-09-24"], "today's 6pm in Karachi");
  assert.equal((await w.ok("planner.add", { kind: "reminder", title: "Email juno", at: "tomorrow at 9" })).at, Z(2026, 9, 25, 4));
  assert.equal((await w.ok("planner.add", { kind: "alarm", at: "7:30" })).at, Z(2026, 9, 24, 14, 30), "the next 7:30");
  assert.equal((await w.ok("planner.add", { kind: "reminder", title: "Oven", at: "in 20 minutes" })).at, T0 + 20 * MIN);
  assert.equal((await w.ok("planner.add", { text: "call kit", kind: "reminder", at: "6pm" })).at, Z(2026, 9, 24, 13), "cc-plugin's shape");
  assert.equal((await w.call("planner.add", { kind: "reminder", title: "x", at: "banana" })).error.code, "bad_input");
  assert.equal((await w.ok("planner.add", { kind: "reminder", title: "ISO still", at: "2026-09-24T20:00:00+05:00" })).at, Z(2026, 9, 24, 15));
});

test("planner: an idle planner never asks Intl for a zone (ICU's zone data is about 8 MB)", async () => {
  // A fresh process, since time.js keeps its formatters: start the planner on an empty store, let
  // its scheduler tick, then add an alarm, counting zoned Intl formatters made on the way.
  const { execFileSync } = await import("node:child_process");
  const script = `
    const Real = Intl.DateTimeFormat; let zoned = 0;
    Intl.DateTimeFormat = function (l, o) { if (o && o.timeZone) zoned++; return new Real(l, o); };
    const { DatabaseSync } = await import("node:sqlite");
    const { migrate } = await import(${JSON.stringify(new URL("../store/index.js", import.meta.url).href)});
    const { createKernel } = await import(${JSON.stringify(new URL("../../kernel/index.js", import.meta.url).href)});
    const k = await createKernel({ space: "spc_aaaaaaaaaaaa", owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 4) });
    const planner = (await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)})).default;
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
    const tools = new Map();
    const h = await planner.start({ name: "planner", config: { role: "box", planner: { timezone: "Asia/Karachi" } }, paths: { root: "/idle" },
      store: { db, migrate: s => migrate(db, "planner", s) }, kernel: k.kernelFor({ name: "planner", needs: ${JSON.stringify(NEEDS)} }), log: () => {}, events: { emit: () => {}, on: () => () => {}, latestId: () => 0 },
      tool: (n, d) => tools.set(n, d), call: async t => t === "google.accounts" ? { data: [] } : { error: { code: "x" } }, remote: async () => ({}) });
    await tools.get("planner.list").run({}, { caller: "cli" });
    const idle = zoned;
    await tools.get("planner.add").run({ kind: "alarm", wall: "07:00" }, { caller: "cli" });
    console.log(JSON.stringify({ idle, after: zoned }));
    await h.stop();`;
  const out = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" }).trim());
  assert.equal(out.idle, 0, "nothing zoned while idle");
  assert.ok(out.after > 0, "a zone is read once there is something to place");
});

test("planner: upcoming lists the next 48 hours of rings, each keyed as the box's push will be", async t => {
  const w = await world(t);
  const alarm = await w.ok("planner.add", { kind: "alarm", title: "Wake", wall: "07:00", repeat: { every: "day" } });
  const rem = await w.ok("planner.add", { kind: "reminder", title: "Call Harlow Legal", at: T0 + 3 * HOUR });
  const timer = await w.ok("planner.add", { kind: "timer", title: "Tea", in_ms: 10 * MIN });
  const ev = await w.ok("planner.add", { kind: "event", title: "Northwind Bakery tasting", at: T0 + 5 * HOUR });
  await w.ok("planner.add", { kind: "todo", title: "No time, never rings" });
  await w.ok("planner.add", { kind: "note", title: "Never rings" });
  const up = await w.ok("planner.upcoming");
  assert.ok(up.last_event > 0, "the event cursor the schedule is current to");
  assert.equal(up.to - up.from, 48 * HOUR);
  const K = (id, due) => `planner-${id}-${due / 1000}`;
  assert.deepEqual(up.entries.map(e => [e.key, e.kind, e.at, e.due * 1000, e.loud]), [
    [K(timer.id, T0 + 10 * MIN), "timer", T0 + 10 * MIN, T0 + 10 * MIN, true],
    [K(rem.id, T0 + 3 * HOUR), "reminder", T0 + 3 * HOUR, T0 + 3 * HOUR, false],
    [K(ev.id, T0 + 5 * HOUR - 10 * MIN), "event", T0 + 5 * HOUR - 10 * MIN, T0 + 5 * HOUR - 10 * MIN, false],
    [K(alarm.id, Z(2026, 9, 25, 2)), "alarm", Z(2026, 9, 25, 2), Z(2026, 9, 25, 2), true],
    [K(alarm.id, Z(2026, 9, 26, 2)), "alarm", Z(2026, 9, 26, 2), Z(2026, 9, 26, 2), true],
  ]);
  assert.equal(up.entries[2].start, T0 + 5 * HOUR, "an event says when it starts");
  assert.equal(up.entries[1].title, "Call Harlow Legal", "titles stay on the user's devices");
  assert.equal((await w.ok("planner.upcoming", { hours: 1 })).entries.length, 1);
  assert.equal((await w.call("planner.upcoming", { hours: 100 })).error.code, "bad_input");

  // The box rings with the same key, and planner.ringing and the ack say it too.
  w.advance(10 * MIN);
  assert.equal(w.fired.at(-1).key, K(timer.id, T0 + 10 * MIN));
  assert.equal((await w.ok("planner.ringing"))[0].key, K(timer.id, T0 + 10 * MIN));
  const r = await w.ok("planner.ringing", { cursor: true });
  assert.ok(r.last_event > 0 && r.ringing.length === 1);
  await w.ok("planner.done", { key: K(timer.id, T0 + 10 * MIN) });
  assert.deepEqual([w.acked.at(-1).key, w.acked.at(-1).action, w.acked.at(-1).unrung], [K(timer.id, T0 + 10 * MIN), "done", undefined]);
  assert.equal((await w.ok("planner.done", { key: K(timer.id, T0 + 10 * MIN) })).already, true, "a retried answer is harmless");
  assert.ok(!(await w.ok("planner.upcoming")).entries.some(e => e.item === timer.id), "a rung moment leaves the schedule");
  const listed = await w.ok("planner.list", { cursor: true });
  assert.ok(Array.isArray(listed.items) && listed.last_event > 0);
  assert.ok(Array.isArray(await w.ok("planner.list")), "without cursor, the list as before");
});

test("planner: a ring answered by key on a device before the box rang it is never rung by the box", async t => {
  const w = await world(t);
  await w.ok("planner.settings", { escalate_max: 0 });
  const alarm = await w.ok("planner.add", { kind: "alarm", title: "Wake", wall: "07:00", repeat: { every: "day" } });
  const rem = await w.ok("planner.add", { kind: "reminder", title: "Call kit", at: T0 + HOUR });
  const snoozed = await w.ok("planner.add", { kind: "reminder", title: "Water the plants", at: T0 + 2 * HOUR });
  const K = (id, due) => `planner-${id}-${due / 1000}`;

  // The phone rang the reminder itself (the box was out of reach) and the user tapped Done; the
  // outbox delivers it by key once the box answers.
  const d = await w.ok("planner.done", { key: K(rem.id, T0 + HOUR) });
  assert.equal(d.item.state, "done");
  assert.deepEqual([d.firing.state, d.firing.action, d.firing.key], ["acked", "done", K(rem.id, T0 + HOUR)]);
  assert.equal(w.acked.at(-1).unrung, true, "the others clear it from their schedules");
  // Tomorrow's alarm, answered ahead: tomorrow is skipped, the day after rings.
  await w.ok("planner.dismiss", { key: K(alarm.id, Z(2026, 9, 25, 2)) });
  // A snooze by key: the moment it was for is skipped, the snooze rings.
  const s = await w.ok("planner.snooze", { key: K(snoozed.id, T0 + 2 * HOUR), minutes: 30 });
  assert.equal(s.until, T0 + 30 * MIN);
  w.advanceTo(Z(2026, 9, 26, 3));
  assert.deepEqual(w.fired.map(f => [f.item, f.at]), [[snoozed.id, T0 + 30 * MIN], [alarm.id, Z(2026, 9, 26, 2)]]);
  assert.equal(w.fired[1].key, K(alarm.id, Z(2026, 9, 26, 2)));
  assert.equal((await w.call("planner.done", { key: "banana" })).error.code, "bad_input");
  assert.equal((await w.call("planner.done", { key: "planner-i_gone-1790000000" })).error.code, "not_found");
});

test("planner: a zone or lead change says the schedule moved", async t => {
  const w = await world(t);
  const moved = [];
  w.events.on("planner.schedule", e => moved.push(e.payload.reason));
  await w.ok("planner.settings", { escalate_max: 1 });
  assert.deepEqual(moved, []);
  await w.ok("planner.settings", { timezone: "Europe/London" });
  await w.ok("planner.settings", { event_lead: 5 });
  assert.deepEqual(moved, ["settings", "settings"]);
});

test("planner: a Vyre-owned session's thread is the assistant, whichever thread it is", async t => {
  const w = await world(t);
  // Straight to the tool: the registry's callers check for "mcp:thread:<id>" is the sessions team's (ADR 0030).
  const run = (name, input, caller) => w.tools.get(name).run(input, { caller });
  const a = await run("planner.add", { kind: "reminder", title: "Call kit", at: T0 + HOUR }, "mcp:thread:t_one");
  assert.equal(a.source, "mcp");
  assert.equal(a.added_by, null);
  const b = await run("planner.update", { item: a.id, title: "Call kit back" }, "mcp:thread:t_two");
  assert.equal(b.title, "Call kit back");
  await assert.rejects(run("planner.update", { item: a.id, title: "x" }, "mcp:agent:kit"), /only the items it added/);
});

test("planner: the vouched meta names the session and the agent, not the label's text (RC-1)", async t => {
  const w = await world(t);
  const run = (name, input, meta) => w.tools.get(name).run(input, meta);
  const a = await run("planner.add", { kind: "reminder", title: "Call kit", at: T0 + HOUR }, { caller: "mcp", thread: "t_one" });
  assert.equal(a.source, "mcp", "a vouched thread on a bare mcp label is a session");
  const b = await run("planner.update", { item: a.id, title: "Call kit back" }, { caller: "mcp:thread:fake", thread: "t_two" });
  assert.equal(b.title, "Call kit back", "any vouched session of the person's own may change it");
  const c = await run("planner.add", { kind: "reminder", title: "Kit's own", at: T0 + HOUR }, { caller: "mcp", agent: "kit" });
  assert.equal(c.source, "agent:kit", "the vouched agent names itself");
  await assert.rejects(run("planner.update", { item: a.id, title: "x" }, { caller: "mcp", agent: "kit" }), /only the items it added/);
});

test("planner: a task fires by posting into its own thread, or launching a fresh one under its creator's own agent", async t => {
  const w = await world(t);
  // A task's firing rings and escalates exactly like an alarm's (nothing here acks it) - not this
  // test's concern, and past the first ring it would run() a second, third time before the next
  // task in this test even fires, racing this test's own "last call" assertions. Off, so each of
  // the three tasks below fires exactly once.
  await w.ok("planner.settings", { escalate_max: 0 });
  const kit = "mcp:agent:kit";
  // With a thread: an existing conversation gets a turn, never a new one. kit is calling FROM s1
  // itself (meta.thread) - taskScope requires a task's own thread match the creator's own calling
  // thread, so this is kit's own scope, not a confused deputy posting into someone else's.
  const withThread = await w.ok("planner.add", { kind: "task", title: "Chase the Northwind invoice", thread: "s1", at: T0 + HOUR }, kit, { thread: "s1", agent: "kit" });
  w.advanceTo(T0 + HOUR);
  await new Promise(r => setImmediate(r)); // runTask() is async; the scheduler fires it, does not await it
  assert.equal(w.taskRuns.length, 1);
  assert.deepEqual([w.taskRuns[0].item, w.taskRuns[0].ok, w.taskRuns[0].result], [withThread.id, true, "ok"]);
  assert.deepEqual(w.calls.at(-1), { tool: "threads.post", input: { thread: "s1", text: "Chase the Northwind invoice", kind: "scheduled", from: "planner" } });
  assert.equal((await w.ok("planner.get", { item: withThread.id })).item.run_count, 1);

  // No thread: a fresh one, under the creator's own agent - rule 1, never more than that agent's own scope.
  const launched = await w.ok("planner.add", { kind: "task", title: "Draft the weekly digest", project: "harlow-legal", at: T0 + 2 * HOUR }, kit);
  w.advanceTo(T0 + 2 * HOUR);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(w.calls.at(-1), { tool: "agents.job", input: { agent: "kit", prompt: "Draft the weekly digest", project: "harlow-legal" } });

  // The person's own task: no agent at all, ambient, same as any session they start themselves.
  const own = await w.ok("planner.add", { kind: "task", title: "Renew the domain", project: "harlow-legal", at: T0 + 3 * HOUR });
  w.advanceTo(T0 + 3 * HOUR);
  await new Promise(r => setImmediate(r));
  assert.equal(w.calls.at(-1).input.agent, undefined);
  assert.equal(own.source, "cli");
});

test("planner: a task runs quietly once per firing - it never rings or escalates like an alarm's unacknowledged one does", async t => {
  const w = await world(t);
  // Default settings: escalate_after 5 min, escalate_max 3 - an alarm left unacked would ring 4
  // times in the next 20 minutes. Nothing here ever acks a task's own firing (planner.done is not
  // called), so before this fix it would have run the model-written instruction 4 times too.
  const task = await w.ok("planner.add", { kind: "task", title: "Send the weekly digest", project: "harlow-legal", at: T0 + HOUR });
  w.advanceTo(T0 + HOUR + 20 * MIN); // past escalate_after (5) x escalate_max (3) = 15 min
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 1, "one firing, one run - never re-run on an escalation ring");
  assert.equal((await w.ok("planner.get", { item: task.id })).item.run_count, 1);
  // The firing itself never escalates either (fireItem's own next_ring, not just runTask's guard).
  assert.equal((await w.ok("planner.get", { item: task.id })).firings.at(-1).ring, 1);
});

test("planner: reviewer HIGH 1 - only a person or a named agent may add a task; a bare session or a module cannot", async t => {
  const w = await world(t);
  // A bare mcp caller (the person's own live Claude session, unnamed) used to become an AMBIENT
  // task at fire time (no agent, the person's full scope) - exactly the escape the reviewer found.
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", thread: "s1" }, "mcp", { thread: "s1" })).error.code, "denied");
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", thread: "s1" }, "mcp:thread:s1", { thread: "s1" })).error.code, "denied");
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", thread: "s1" }, "harness:thread:s1", { thread: "s1" })).error.code, "denied");
  // Any module (first-party or not) is refused outright - it is never "an agent the person named".
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", thread: "s1" }, "module:watchers", { thread: "s1" })).error.code, "denied");
  // Every other kind is unaffected - only a task fires unattended later.
  await w.ok("planner.add", { kind: "reminder", title: "x", at: T0 + MIN }, "mcp");
  await w.ok("planner.add", { kind: "todo", title: "x" }, "module:watchers");
});

test("planner: reviewer HIGH 2 - a task may only target the creator's OWN calling thread, never any thread it names", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  // kit is calling from s1, but names s2 (someone else's thread, or one it has no business in):
  // the confused-deputy escape - module:planner would have posted there as itself, unquestioned.
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", thread: "s2" }, kit, { thread: "s1", agent: "kit" })).error.code, "denied");
  // Its own calling thread is fine.
  const ok = await w.ok("planner.add", { kind: "task", title: "x", thread: "s1" }, kit, { thread: "s1", agent: "kit" });
  assert.equal(ok.thread, "s1");
  // Neither a thread nor a project at all: no scope to check against, refused rather than
  // defaulting to an ambient launch.
  assert.equal((await w.call("planner.add", { kind: "task", title: "x" }, kit, { thread: "s1", agent: "kit" })).error.code, "denied");
});

test("planner: reviewer MEDIUM - a task's project must be inside the creator agent's own projects.access, at add, at edit and again at fire", async t => {
  const w = await world(t);
  const kit = "mcp:agent:kit";
  w.agents = [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent", projects: ["harlow-legal"] }];
  // Outside kit's own scope: refused at add time.
  assert.equal((await w.call("planner.add", { kind: "task", title: "x", project: "northwind" }, kit)).error.code, "denied");
  const t1 = await w.ok("planner.add", { kind: "task", title: "Draft the weekly digest", project: "harlow-legal", at: T0 + HOUR }, kit);

  // Reviewer HIGH 2's update-time twin: kit cannot redirect its own task to a project outside its
  // scope after the fact either (planner.update takes the same path as planner.add).
  assert.equal((await w.call("planner.update", { item: t1.id, project: "northwind" }, kit)).error.code, "denied");
  await w.ok("planner.update", { item: t1.id, priority: 2 }, kit, { thread: "s1", agent: "kit" }); // unrelated field: untouched, no scope check at all

  // MEDIUM: kit's access to harlow-legal is revoked after scheduling, before it ever fires -
  // caught again at runTask, not just at add/edit time.
  w.agents = [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent", projects: [] }];
  w.advanceTo(T0 + HOUR);
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns[0].ok, false);
  assert.match(w.taskRuns[0].result, /no longer has access/);
  assert.equal((await w.ok("planner.get", { item: t1.id })).item.run_count, 1, "an attempt is still recorded (rule 2)");
});

test("planner: a paused task never runs; a failed run is recorded, not thrown away", async t => {
  const w = await world(t);
  const paused = await w.ok("planner.add", { kind: "task", title: "Ping the standup channel", thread: "s1", at: T0 + HOUR, paused: true });
  w.advanceTo(T0 + HOUR);
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 0);
  assert.equal((await w.ok("planner.update", { item: paused.id, paused: false })).paused, false);

  const w2 = await world(t);
  w2.onCall = async () => ({ error: { code: "not_found", message: "no such thread" } });
  const failing = await w2.ok("planner.add", { kind: "task", title: "Post to a thread that is gone", thread: "s9", at: T0 + HOUR });
  w2.advanceTo(T0 + HOUR);
  await new Promise(r => setImmediate(r));
  assert.equal(w2.taskRuns[0].ok, false);
  assert.match(w2.taskRuns[0].result, /no such thread/);
  assert.equal((await w2.ok("planner.get", { item: failing.id })).item.last_result, "error: no such thread");
});

test("planner: a chained task (waits_on) runs when its dependency is marked done, never on a timer of its own", async t => {
  const w = await world(t);
  const first = await w.ok("planner.add", { kind: "todo", title: "Sign the contract", project: "harlow-legal" });
  const then = await w.ok("planner.add", { kind: "task", title: "Kick off onboarding", thread: "s1", waits_on: first.id });
  assert.equal(then.at, null, "nothing to schedule: it waits on first, not a time");
  await new Promise(r => setImmediate(r)); // planner.changed's listener is async
  assert.equal(w.taskRuns.length, 0, "not yet - first is still open");
  await w.ok("planner.done", { item: first.id });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 1);
  assert.deepEqual(w.calls.at(-1), { tool: "threads.post", input: { thread: "s1", text: "Kick off onboarding", kind: "scheduled", from: "planner" } });
  // Finishing something unrelated never fires it a second time.
  const other = await w.ok("planner.add", { kind: "todo", title: "Unrelated", project: "harlow-legal" });
  await w.ok("planner.done", { item: other.id });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 1);
});

test("planner: reopening a chained task's dependency and finishing it again does not re-fire it a second time for the same completion", async t => {
  const w = await world(t);
  // A reminder, not a todo: a done todo is a done task in the kernel and does not reopen.
  const first = await w.ok("planner.add", { kind: "reminder", title: "Sign the contract", project: "harlow-legal", at: T0 + 5 * HOUR });
  await w.ok("planner.add", { kind: "task", title: "Kick off onboarding", thread: "s1", waits_on: first.id });
  await w.ok("planner.done", { item: first.id });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 1, "fires once on the first done");
  // Reopen, then finish it again: still the same underlying completion in spirit, but a NEW
  // done_at - a person redoing the same dependency is a legitimate second trigger.
  await w.ok("planner.update", { item: first.id, state: "open" });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 1, "reopening alone never fires it");
  w.advanceTo(T0 + 1000); // a distinct done_at from the first completion
  await w.ok("planner.done", { item: first.id });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, 2, "a genuinely new done_at fires again");
  // But re-delivering the SAME planner.changed (e.g. a duplicate event, or another field on the
  // done row changing without a new done_at) must not re-fire it.
  const before = w.taskRuns.length;
  await w.ok("planner.update", { item: first.id, title: "Sign the contract (updated)" });
  await new Promise(r => setImmediate(r));
  assert.equal(w.taskRuns.length, before, "a change with no new done_at never re-fires it");
});
