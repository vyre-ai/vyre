// @ts-check
// The planner's calendar slice on a fake clock, with a fake google module behind ctx.call: the
// google.* tools answer from an in-memory calendar per account, and an invite with attendees is
// held (as core/google does at the Gate) instead of written. Nothing reaches Google.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import planner, { seams } from "./index.js";
import { rowId } from "./calendar.js";
import { migrate } from "../store/index.js";
import { Events } from "../events/index.js";
import { callerAllowed } from "../modules/index.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const T0 = Z(2026, 9, 24, 5); // Thursday 10:00 in Karachi
const iso = ms => new Date(ms).toISOString();
let homes = 0;

/** A fake google module: accounts, their events, a failing switch per account, and what was held. */
function fakeGoogle() {
  const g = {
    /** @type {Map<string, any[]>} */ accounts: new Map(),
    failing: new Set(),
    /** @type {any[]} */ calls: [],
    /** @type {any[]} */ held: [],
    seq: 0,
    add(name, events = []) { g.accounts.set(name, events); },
    async call(tool, input) {
      g.calls.push([tool, input]);
      if (tool === "google.accounts") return { data: [...g.accounts.keys()].map(name => ({ name, email: `${name}@example.com` })) };
      if (tool === "google.calendar.list") {
        const name = input.account;
        if (!g.accounts.has(name)) return { error: { code: "bad_input", message: `no account ${name}` } };
        if (g.failing.has(name)) return { error: { code: "google", message: `${name}: 401 token revoked` } };
        const from = Date.parse(input.from), to = Date.parse(input.to);
        const ms = v => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v);
        const events = g.accounts.get(name).filter(e => ms(e.end || e.start) > from && ms(e.start) < to)
          .map(e => ({ attendees: [], url: `https://calendar.example/${e.id}`, account: name, ...e }))
          .sort((a, b) => ms(a.start) - ms(b.start)).slice(0, input.limit || 25);
        return { data: { events } };
      }
      if (tool === "google.calendar.create") {
        const to = [].concat(input.attendees || []).filter(Boolean);
        if (to.length) {
          const id = `g_${++g.seq}`;
          g.held.push({ id, to, input });
          return { data: { held: id, message: `Held at the Gate: the invite goes to ${to.join(", ")} once the user approves it in Vyre. Nothing was created yet.` } };
        }
        const event = { id: `ev_${++g.seq}`, account: input.account, title: input.title, start: input.start, end: input.end || iso(Date.parse(input.start) + HOUR),
          ...(input.where ? { where: input.where } : {}), attendees: [], url: `https://calendar.example/new` };
        g.accounts.get(input.account)?.push(event);
        return { data: { event } };
      }
      return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    },
  };
  return g;
}

async function world(t, { tz = "Asia/Karachi", start = T0, google = fakeGoogle() } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(db);
  const root = `/planner-cal-test-${++homes}`;
  const clock = { t: start };
  /** @type {Map<number, { at: number, ms: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
  t.after(() => seams.delete(root));
  const fired = [], acked = [];
  events.on("planner.fired", e => fired.push({ at: clock.t, ...e.payload }));
  events.on("planner.acked", e => acked.push(e.payload));
  /** @type {Map<string, any>} */
  const tools = new Map();
  const ctx = {
    name: "planner", config: { role: "box", planner: { timezone: tz } }, paths: { root },
    store: { db, migrate: steps => migrate(db, "planner", steps) },
    log: () => {},
    events: { emit: (type, p, where) => events.emit("planner", type, p, where), on: (p, fn) => events.on(p, fn) },
    tool: (name, def) => tools.set(name, def),
    call: async (tool, input) => google.call(tool, input),
    remote: async () => ({ error: { code: "no_link", message: "no link" } }),
  };
  const handle = await planner.start(ctx);
  t.after(() => handle.stop());
  const w = {
    db, events, clock, timers, fired, acked, google, handle,
    settled: () => handle.calendar.settled(),
    async call(name, input = {}, caller = "cli") {
      const def = tools.get(name);
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
    /** Move the clock on, running each timer as its moment comes, and let a sync it starts finish. */
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
        await handle.calendar.settled();
      }
      clock.t = end;
    },
    /** The google module telling everyone an account came or went. */
    async announce(type, name) { events.emit("google", type, { name }); await handle.calendar.settled(); },
    rows: () => db.prepare("SELECT account, event_id, title, start, end, all_day FROM planner_calendar ORDER BY start").all().map(r => ({ ...r })),
    lists: () => google.calls.filter(c => c[0] === "google.calendar.list").length,
  };
  await w.settled();
  return w;
}

test("calendar: sync caches the window, drops what is gone, keeps a failing account's copy, and forgets a removed account", async t => {
  const google = fakeGoogle();
  google.add("alex", [
    { id: "a1", title: "Harlow Legal intake", start: iso(T0 + 2 * HOUR), end: iso(T0 + 3 * HOUR), where: "Room 2" },
    { id: "a2", title: "Offsite", start: "2026-09-25", end: "2026-09-26" },
    { id: "a3", title: "Far away", start: iso(T0 + 20 * DAY), end: iso(T0 + 20 * DAY + HOUR) },
    { id: "a0", title: "Yesterday", start: iso(T0 - 3 * DAY), end: iso(T0 - 3 * DAY + HOUR) },
  ]);
  google.add("northwind", [{ id: "n1", title: "Northwind Bakery tasting", start: iso(T0 + DAY), end: iso(T0 + DAY + HOUR) }]);
  const w = await world(t, { google });
  // The boot sync already ran; asking again is the same.
  const r = await w.ok("planner.calendar.sync");
  assert.deepEqual([r.accounts, r.events, r.removed], [["alex", "northwind"], 3, 0]);
  assert.equal(r.synced_at, T0);
  const list = google.calls.find(c => c[0] === "google.calendar.list")[1];
  assert.deepEqual([list.from, list.to], [iso(T0 - DAY), iso(T0 + 14 * DAY)], "a day back to 14 days ahead");
  assert.deepEqual(w.rows().map(x => [x.account, x.event_id, x.all_day]), [["alex", "a1", 0], ["alex", "a2", 1], ["northwind", "n1", 0]]);
  // An all-day date is midnight to midnight in the planner's zone.
  const offsite = w.rows().find(x => x.event_id === "a2");
  assert.deepEqual([offsite.start, offsite.end], [Z(2026, 9, 24, 19), Z(2026, 9, 25, 19)]);
  assert.equal(w.db.prepare("SELECT synced_at FROM planner_calendar WHERE event_id = 'a1'").get().synced_at, T0);

  // a1 is cancelled; northwind's token is revoked and its event is gone too, but its copy stays.
  google.accounts.set("alex", google.accounts.get("alex").filter(e => e.id !== "a1"));
  google.accounts.set("northwind", []);
  google.failing.add("northwind");
  const r2 = await w.ok("planner.calendar.sync");
  assert.equal(r2.removed, 1);
  assert.deepEqual(r2.errors, [{ account: "northwind", error: "northwind: 401 token revoked" }]);
  assert.deepEqual(w.rows().map(x => x.event_id), ["a2", "n1"]);

  // The account is removed: its events go with it.
  google.accounts.delete("northwind");
  await w.announce("google.removed", "northwind");
  assert.deepEqual(w.rows().map(x => x.event_id), ["a2"]);
});

test("calendar: the 15-minute sync runs only while an account is connected", async t => {
  const w = await world(t);
  assert.equal(w.timers.size, 0, "no account, no timer");
  await w.advance(2 * HOUR);
  assert.equal(w.lists(), 0, "never read without an account");

  w.google.add("alex", []);
  await w.announce("google.added", "alex");
  assert.equal(w.lists(), 1, "an added account is read at once");
  assert.deepEqual([...w.timers.values()].map(x => x.ms), [15 * MIN]);
  await w.advance(HOUR);
  assert.equal(w.lists(), 5, "every 15 minutes");
  assert.ok([...w.timers.values()].every(x => x.ms >= MIN), "nothing sooner than a minute");

  w.google.accounts.delete("alex");
  await w.announce("google.removed", "alex");
  const n = w.lists();
  assert.equal(w.timers.size, 0, "the last account gone, no timer");
  await w.advance(2 * HOUR);
  assert.equal(w.lists(), n);
});

test("calendar: a timed event rings once, event_lead before its start, however often it is synced; an all-day one never rings", async t => {
  const google = fakeGoogle();
  const start = T0 + 2 * HOUR;
  google.add("alex", [
    { id: "e1", title: "Call juno", start: iso(start), end: iso(start + 30 * MIN) },
    { id: "d1", title: "kit's birthday", start: "2026-09-24", end: "2026-09-25" },
    { id: "d2", title: "Harlow Legal offsite", start: "2026-09-25", end: "2026-09-26" },
  ]);
  const w = await world(t, { google });
  await w.advance(start - 10 * MIN - 1000 - T0);
  assert.equal(w.fired.length, 0);
  await w.advance(1000);
  assert.equal(w.fired.length, 1);
  const f = w.fired[0];
  assert.deepEqual({ ...f, firing: "x" }, { at: start - 10 * MIN, firing: "x", item: rowId("alex", "e1"), kind: "event", title: "Call juno",
    due: start - 10 * MIN, ring: 1, missed: false, actions: ["done", "snooze"], account: "alex", start });
  // Synced again (by hand and by the timer), renamed with the same start: no second ring.
  google.accounts.get("alex")[0].title = "Call juno about Northwind Bakery";
  await w.ok("planner.calendar.sync");
  await w.ok("planner.calendar.sync");
  await w.advance(2 * DAY);
  assert.equal(w.fired.length, 1, "one ring for one start; all-day events never ring");
  assert.equal(w.rows().find(r => r.event_id === "e1"), undefined, "past the window, dropped");

  // A moved event is a new start: it rings for that one.
  const later = w.clock.t + 3 * HOUR;
  google.accounts.get("alex").push({ id: "e2", title: "Harlow Legal review", start: iso(later), end: iso(later + HOUR) });
  await w.ok("planner.calendar.sync");
  const moved = later + HOUR;
  google.accounts.get("alex").at(-1).start = iso(moved);
  google.accounts.get("alex").at(-1).end = iso(moved + HOUR);
  await w.ok("planner.calendar.sync");
  await w.advance(6 * HOUR);
  assert.deepEqual(w.fired.slice(1).map(x => [x.item, x.at]), [[rowId("alex", "e2"), moved - 10 * MIN]]);
});

test("calendar: a calendar ring snoozes and is done like any other; a new event_lead moves pending rings", async t => {
  const google = fakeGoogle();
  const start = T0 + HOUR;
  google.add("alex", [{ id: "e1", title: "Northwind Bakery call", start: iso(start), end: iso(start + HOUR) }]);
  const w = await world(t, { google });
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

test("calendar: agenda merges the planner's events and every calendar's in order, with busy time merged across zones and a next shortcut", async t => {
  const google = fakeGoogle();
  google.add("alex", [
    // 11:30 to 12:30 in Karachi, written in Los Angeles time.
    { id: "a1", title: "Harlow Legal intake", start: "2026-09-23T23:30:00-07:00", end: "2026-09-24T00:30:00-07:00", where: "https://meet.example/abc" },
    { id: "a2", title: "Offsite", start: "2026-09-24", end: "2026-09-25" },
  ]);
  // 12:00 to 13:30 in Karachi, written in Tokyo time; and 16:00 to 17:00 on its own.
  google.add("northwind", [
    { id: "n1", title: "Northwind Bakery tasting", start: "2026-09-24T16:00:00+09:00", end: "2026-09-24T17:30:00+09:00" },
    { id: "n2", title: "Supplier call", start: "2026-09-24T20:00:00+09:00", end: "2026-09-24T21:00:00+09:00" },
  ]);
  const w = await world(t, { google });
  // The planner's own event, 10:30 to 11:45 in Karachi: it overlaps the intake.
  const own = await w.ok("planner.calendar.create", { title: "Plan with kit", start: "2026-09-24T10:30", end: "2026-09-24T11:45", where: "Studio" });
  await w.ok("planner.add", { kind: "alarm", title: "Stretch", wall: "11:30", date: "2026-09-24" });

  const day = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-24" });
  assert.deepEqual(day.entries.map(e => [e.source, e.title]), [
    ["alex", "Offsite"], ["planner", "Plan with kit"], ["planner", "Stretch"], ["alex", "Harlow Legal intake"], ["northwind", "Northwind Bakery tasting"],
    ["northwind", "Supplier call"]]);
  const intake = day.entries.find(e => e.title === "Harlow Legal intake");
  assert.deepEqual([intake.start, intake.end, intake.all_day, intake.where, intake.url], [Z(2026, 9, 24, 6, 30), Z(2026, 9, 24, 7, 30), false,
    "https://meet.example/abc", "https://calendar.example/a1"]);
  const mine = day.entries.find(e => e.item === own.id);
  assert.deepEqual([mine.start, mine.end, mine.all_day, mine.where, mine.url], [Z(2026, 9, 24, 5, 30), Z(2026, 9, 24, 6, 45), false, "Studio", null]);
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

test("calendar: create makes the planner's own event, or goes through google.calendar.create where attendees are held", async t => {
  const google = fakeGoogle();
  google.add("alex", []);
  const w = await world(t, { google });
  const own = await w.ok("planner.calendar.create", { title: "Bake with juno", start: iso(T0 + 3 * HOUR) });
  assert.deepEqual([own.kind, own.at, own.duration_ms, own.source], ["event", T0 + 3 * HOUR, HOUR, "cli"]);
  assert.equal(google.calls.filter(c => c[0] === "google.calendar.create").length, 0, "no account, nothing sent to Google");
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + HOUR), end: iso(T0) })).error.code, "bad_input");

  // Attendees: the google module holds the invite at the Gate; nothing is written or cached.
  const held = await w.ok("planner.calendar.create", { title: "Harlow Legal kickoff", start: "2026-09-25T15:00", account: "alex",
    attendees: ["kit@example.com"], where: "Harlow Legal" });
  assert.equal(held.held, "g_1");
  assert.match(held.message, /Held at the Gate/);
  const sent = google.calls.find(c => c[0] === "google.calendar.create")[1];
  assert.deepEqual(sent, { title: "Harlow Legal kickoff", start: "2026-09-25T10:00:00.000Z", account: "alex", time_zone: "Asia/Karachi",
    where: "Harlow Legal", attendees: ["kit@example.com"] });
  assert.equal(w.rows().length, 0);

  // No attendees: written at once, and the copy has it with its reminder.
  const made = await w.ok("planner.calendar.create", { title: "Northwind Bakery order", start: iso(T0 + 2 * HOUR), account: "alex" });
  assert.equal(made.event.title, "Northwind Bakery order");
  assert.deepEqual(w.rows().map(r => r.title), ["Northwind Bakery order"]);
  await w.advance(2 * HOUR);
  assert.deepEqual(w.fired.map(f => [f.title, f.at]), [["Northwind Bakery order", T0 + 2 * HOUR - 10 * MIN]]);

  // An agent may ask for an invite (still held), and nothing else.
  const kit = "mcp:agent:kit";
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + 5 * HOUR) }, kit)).error.code, "denied");
  assert.equal((await w.call("planner.calendar.create", { title: "x", start: iso(T0 + 5 * HOUR), account: "alex" }, kit)).error.code, "denied");
  const asked = await w.ok("planner.calendar.create", { title: "Catch up", start: iso(T0 + 5 * HOUR), account: "alex", attendees: "juno@example.com" }, kit);
  assert.equal(asked.held, "g_3");
  assert.equal(google.held.length, 2);
  assert.ok((await w.ok("planner.calendar.sync", {}, kit)).accounts.includes("alex"), "agents may sync");
});
