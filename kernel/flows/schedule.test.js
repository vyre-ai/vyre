// Schedules (R032-09): time zone, business hours, holidays and what to do about the times missed while the server was off.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { checkFlow } from "./schema.js";
import { nextFire, nextOpen, allowedAt, dueTimes, checkSchedule, holidaysFrom, describeWindow } from "./schedule.js";
import { describeTrigger } from "./triggers.js";

const NY = "America/New_York";
/** A wall time in New York in October 2026 (daylight time, UTC-4) as UTC ms. @param {number} day @param {number} h @param {number} [m] */
const ny = (day, h, m = 0) => Date.UTC(2026, 9, day, h + 4, m);
// 9 Oct 2026 is a Friday; 12 Oct is the Monday after.
const HOURS = { on: "time", cron: "*/30 * * * *", tz: NY, hours: true };

test("schedule keys: hours, holidays and catch_up are checked with words that say what to write", () => {
  const bad = t => { const out = []; checkSchedule(t, out); return out.map(p => `${p.path}: ${p.message}`).join(" | "); };
  assert.equal(bad({ on: "time", cron: "0 9 * * *", hours: true, holidays: ["2026-12-25", "07-04"], catch_up: "all" }), "");
  assert.match(bad({ hours: "always" }), /hours is true/);
  assert.match(bad({ hours: { days: ["mon", "funday"] } }), /days is a list of sun, mon/);
  assert.match(bad({ hours: { from: "9am" } }), /from is a time like 09:00/);
  assert.match(bad({ hours: { from: "17:00", to: "09:00" } }), /from must be earlier than to/);
  assert.match(bad({ holidays: ["Christmas"] }), /holidays is "space" or a list/);
  assert.match(bad({ catch_up: "twice" }), /catch_up is once, all, skip/);
  assert.match(bad({ at: 1, hours: true }), /not a single set time/);
  const flow = hours => ({ format: 1, name: "t", authorship: "human", trigger: { on: "time", every_ms: 3_600_000, ...hours }, steps: [{ id: "m", kind: "create", type: "matter", set: {} }] });
  assert.deepEqual(checkFlow(flow({ hours: true, tz: NY })), [], "an interval with business hours may name its zone");
  assert.match(JSON.stringify(checkFlow(flow({ tz: NY }))), /time zone goes with a cron schedule or business hours/);
});

test("business hours: a cron time outside the window is skipped, an interval waits for the window to open", () => {
  assert.equal(nextFire(HOURS, ny(9, 16, 20), NY), ny(9, 16, 30), "inside the window");
  assert.equal(nextFire(HOURS, ny(9, 16, 40), NY), ny(12, 9), "17:00 is closed; Monday 9:00 is next");
  assert.equal(nextFire(HOURS, ny(10, 12), NY), ny(12, 9), "a Saturday waits for Monday");
  assert.equal(nextFire(HOURS, ny(9, 8, 59), NY), ny(9, 9), "the window opens at 9:00 sharp");
  const every = { on: "time", every_ms: 2 * 3_600_000, tz: NY, hours: true };
  assert.equal(nextFire(every, ny(9, 15, 30), NY), ny(12, 9), "15:30 + 2 h = 17:30 is closed, so it opens Monday");
  assert.equal(nextFire(every, ny(12, 9), NY), ny(12, 11), "and counts again from there");
  const late = { ...HOURS, hours: { days: ["tue", "thu"], from: "10:00", to: "12:00" } };
  assert.equal(nextFire(late, ny(9, 17), NY), ny(13, 10), "Tuesday 13 Oct 10:00");
  assert.equal(allowedAt(ny(13, 11, 59), late, NY), true);
  assert.equal(allowedAt(ny(13, 12), late, NY), false, "the closing time is outside");
  assert.equal(allowedAt(ny(14, 11), late, NY), false, "Wednesday is not a day it keeps");
});

test("business hours: a once-a-minute line is not walked through the night, and a line the window never allows ends in null", () => {
  const minutely = { on: "time", cron: "* * * * *", tz: NY, hours: true };
  const t0 = Date.now();
  assert.equal(nextFire(minutely, ny(9, 16, 59), NY), ny(12, 9), "Friday after closing: Monday at the opening minute");
  assert.equal(nextFire(minutely, ny(9, 10, 5), NY), ny(9, 10, 6), "inside the window it is the next minute");
  assert.equal(nextFire({ ...minutely, cron: "0 18 * * *" }, ny(9, 10), NY), null, "6 pm is never inside the window");
  assert.ok(Date.now() - t0 < 5000, `it took ${Date.now() - t0} ms (a minute-by-minute walk took 37 s)`);
  const week = dueTimes(minutely, ny(5, 8), ny(9, 18), NY, [], 50);
  assert.equal(week.times[0], ny(5, 9), "the first due time is the opening of Monday");
});

test("row 15: a once-a-minute line with a one-hour Monday window, and one over a long holiday stretch, still find their next time", () => {
  const t0 = Date.now();
  // the old walk gave up after 5,000 cron steps (about three and a half days of minutes), so the schedule never fired again
  const monday = { on: "time", cron: "* * * * *", tz: NY, hours: { days: ["mon"], from: "09:00", to: "10:00" } };
  assert.equal(nextFire(monday, ny(6, 10, 30), NY), ny(12, 9), "Tuesday-to-Monday gap: the next Monday at the opening minute");
  assert.equal(nextFire(monday, ny(12, 9, 59), NY), ny(19, 9), "the window closes at 10:00: the next time is the Monday after");
  const days = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
  const stretch = { on: "time", cron: "* * * * *", tz: NY, holidays: days };
  assert.equal(nextFire(stretch, ny(7, 0, 0), NY), ny(15, 0, 0), "eight days off: the first minute after them");
  assert.equal(nextFire({ ...stretch, cron: "0 9 * * *" }, ny(7, 0, 0), NY), ny(15, 9, 0));
  const due = dueTimes(monday, ny(6, 10, 30), ny(12, 9, 2), NY, [], 50);
  assert.deepEqual(due.times, [ny(12, 9, 0), ny(12, 9, 1), ny(12, 9, 2)], "and the times it was due are found, not lost");
  assert.ok(Date.now() - t0 < 5000, `it took ${Date.now() - t0} ms`);
});

test("holidays: a date is skipped once, a month-day every year, and the Space's list applies with business hours", () => {
  const t = { on: "time", cron: "0 9 * * 1-5", tz: NY, holidays: ["2026-10-12", "12-25"] };
  assert.equal(nextFire(t, ny(9, 10), NY), ny(13, 9), "Monday 12 Oct is a holiday");
  assert.equal(nextFire({ ...t, holidays: ["10-12"] }, ny(9, 10), NY), ny(13, 9), "month-day form");
  assert.equal(nextFire({ ...t, holidays: ["10-12"] }, Date.UTC(2027, 9, 11, 14), NY), Date.UTC(2027, 9, 13, 13), "and again next year: Tuesday 12 Oct 2027 is off, so Wednesday");
  const withHours = { on: "time", cron: "0 9 * * 1-5", tz: NY, hours: true };
  assert.equal(nextFire(withHours, ny(9, 10), NY, ["2026-10-12"]), ny(13, 9), "business hours keep the Space's holidays");
  assert.equal(nextFire({ ...withHours, holidays: [] }, ny(9, 10), NY, ["2026-10-12"]), ny(12, 9), "a list of its own replaces the Space's");
  assert.equal(nextFire({ on: "time", cron: "0 9 * * 1-5", tz: NY }, ny(9, 10), NY, ["2026-10-12"]), ny(12, 9), "a schedule that says nothing of holidays ignores the Space's");
  assert.equal(nextFire({ on: "time", cron: "0 9 * * 1-5", tz: NY, holidays: "space" }, ny(9, 10), NY, ["2026-10-12"]), ny(13, 9));
  assert.equal(nextOpen(ny(12, 8), withHours, NY, ["2026-10-12"]), ny(13, 9));
  assert.deepEqual(holidaysFrom("2026-12-25, 07-04\n13-45 nonsense; 2027-01-01"), ["2026-12-25", "07-04", "2027-01-01"]);
});

test("due times: everything due since the last run, oldest first, capped, with the count left over", () => {
  const daily = { on: "time", cron: "0 9 * * 1-5", tz: NY };
  const r = dueTimes(daily, ny(5, 10), ny(9, 12), NY, []);
  assert.deepEqual(r.times, [ny(6, 9), ny(7, 9), ny(8, 9), ny(9, 9)]);
  assert.equal(r.more, 0);
  const many = dueTimes({ on: "time", every_ms: 60_000 }, 0, 120 * 60_000, "UTC", [], 50);
  assert.equal(many.times.length, 50);
  assert.equal(many.more, 70);
  const week = dueTimes({ on: "time", cron: "*/5 * * * *", tz: NY }, 0, 7 * 86_400_000, NY, [], 50);
  assert.equal(week.times.length + week.more, 1000, "the walk stops at a thousand times");
  assert.equal(describeWindow({ hours: true, catch_up: "skip" }), "weekdays 9:00 to 17:00; not on the Space's holidays; after downtime, skips what was missed");
  assert.match(describeTrigger({ on: "time", cron: "0 9 * * *", tz: NY, hours: { days: ["mon", "wed"], from: "08:30", to: "12:00" }, holidays: ["12-25"] }), /On a schedule .*, mon, wed 8:30 to 12:00; not on 1 listed day/);
});

// ---- the runner: what tick() starts after downtime, by rule

const DAILY = { on: "time", cron: "0 9 * * 1-5", tz: NY };
const stepsOf = () => [{ id: "m", kind: "create", type: "payment", set: { amount: 1 } }];
/** A Flow on this schedule installed on Monday 5 Oct at 10:00 New York; the server is then off until Friday noon. */
async function offUntilFriday(trigger, o = {}) {
  const w = await world(o);
  w.clock.t = ny(5, 10);
  const { id } = await install(w, { format: 1, name: "daily", authorship: "human", trigger, steps: stepsOf() });
  await w.runner.tick(); await settle(w);
  assert.equal((await w.runner.listRuns({ flow: id })).length, 0, "nothing is due the moment it is installed");
  w.clock.t = ny(9, 12);
  await w.runner.tick(); await settle(w);
  const runs = (await w.runner.listRuns({ flow: id })).sort((a, b) => a.trigger.at - b.trigger.at);
  return { w, id, runs };
}

test("catch up once (the default): one run for all that was missed, saying how many it skipped", async () => {
  const { runs } = await offUntilFriday(DAILY);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger.at, ny(6, 9), "it stands for the first missed time");
  assert.deepEqual([runs[0].trigger.caught_up, runs[0].trigger.missed], [true, 3]);
});

test("catch up all: one run for every time missed, each at its own time", async () => {
  const { runs, w } = await offUntilFriday({ ...DAILY, catch_up: "all" });
  assert.deepEqual(runs.map(r => r.trigger.at), [ny(6, 9), ny(7, 9), ny(8, 9), ny(9, 9)]);
  assert.ok(runs.every(r => r.trigger.caught_up === true));
  assert.equal([...w.kernel.tables.get("payment").values()].length, 4);
  await w.runner.tick(); await settle(w);
  assert.equal((await w.runner.listRuns({ flow: runs[0].flow })).length, 4, "and the next tick starts no more");
});

test("catch up skip: nothing runs for the missed times, and the next real time still does", async () => {
  const { runs, w, id } = await offUntilFriday({ ...DAILY, catch_up: "skip" });
  assert.equal(runs.length, 0);
  w.clock.t = ny(12, 9, 0);
  await w.runner.tick(); await settle(w);
  const next = await w.runner.listRuns({ flow: id });
  assert.equal(next.length, 1);
  assert.equal(next[0].trigger.at, ny(12, 9));
  assert.equal(next[0].trigger.caught_up, undefined, "on time");
});

test("holidays and business hours decide which times are due, and nextWake names the next open one", async () => {
  const { runs, w, id } = await offUntilFriday({ ...DAILY, catch_up: "all", holidays: ["2026-10-08"] });
  assert.deepEqual(runs.map(r => r.trigger.at), [ny(6, 9), ny(7, 9), ny(9, 9)], "Thursday was a holiday");
  assert.equal(await w.runner.nextWake(), ny(12, 9), "Monday is next");
  void id;
  const spaceList = await world({ settings: async key => (key === "flows.holidays" ? "2026-10-12" : undefined) });
  spaceList.clock.t = ny(9, 12);
  await install(spaceList, { format: 1, name: "weekday", authorship: "human", trigger: { on: "time", cron: "0 9 * * 1-5", tz: NY, hours: true }, steps: stepsOf() });
  await spaceList.runner.tick();
  assert.equal(await spaceList.runner.nextWake(), ny(13, 9), "the Space's holiday list keeps Monday 12 Oct off");
});

test("a practice run over last week counts the schedule's real times: zone, hours and holidays", async () => {
  const w = await world();
  const flow = { format: 1, name: "daily", authorship: "human", trigger: { ...DAILY, holidays: ["2026-10-08"] }, steps: stepsOf() };
  const r = await w.runner.simulate(flow, { approver: { kind: "person", id: "per_alex" }, since: ny(5, 0), until: ny(10, 0) });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.runs.map(x => x.at), [ny(5, 9), ny(6, 9), ny(7, 9), ny(9, 9)], "Monday to Friday at 9:00 New York, Thursday off");
});

test("the lines form (what @Engineer writes) of a scheduled Flow with lanes and a sub-flow reads back as the same Flow", async () => {
  const { printLines, parseLines } = await import("./lines.js");
  const { checkFlow } = await import("./schema.js");
  const flow = { format: 1, name: "weekday_check", label: "Weekday check", authorship: "human", trigger: { on: "time", cron: "0 9 * * 1-5", tz: "America/New_York", hours: true, holidays: "space", catch_up: "skip" },
    steps: [{ id: "p", kind: "parallel", steps: [
      { id: "fees", kind: "branch", steps: [{ id: "find", kind: "find", type: "matter", where: "record.stage != \"Closed\"" }] },
      { id: "call", kind: "branch", steps: [{ id: "task", kind: "assign", to: "role:manager", title: "Call the client", output: { kind: "note" } }] }] },
    { id: "mail", kind: "subflow", flow: "follow_up_email", input: { client: { expr: "trigger.client" } } }] };
  const back = parseLines(printLines(flow));
  assert.deepEqual(back.trigger, flow.trigger);
  assert.deepEqual(back.steps.map(s => [s.id, s.kind]), [["p", "parallel"], ["mail", "subflow"]]);
  assert.deepEqual(back.steps[0].steps.map(s => [s.id, s.kind, s.steps.map(x => x.id)]), [["fees", "branch", ["find"]], ["call", "branch", ["task"]]]);
  assert.deepEqual(checkFlow({ ...back, format: 1, name: "weekday_check", authorship: "human" }), []);
});
