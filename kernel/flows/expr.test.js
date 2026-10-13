import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, run, roots, stepRefs, ExprError } from "./expr.js";

const scope = { trigger: { amount: 250, client: { name: "Harlow Legal" }, tags: ["a", "b"] }, steps: { research: { rows: [{ size: "small" }] } }, stage: "Intake" };

test("expr: comparison, boolean logic, membership and arithmetic", () => {
  assert.equal(run("trigger.amount > 100 and lower(trigger.client.name) contains \"harlow\"", scope), true);
  assert.equal(run("steps.research.rows[0].size in [\"small\", \"medium\"] or stage == \"Closed\"", scope), true);
  assert.equal(run("not (stage == \"Intake\")", scope), false);
  assert.equal(run("1 + 2 * 3 - 4 / 2", scope), 5);
  assert.equal(run("trigger.tags contains \"b\"", scope), true);
  assert.equal(run("\"a\" in \"cat\"", scope), true);
  assert.equal(run("days(2) / hours(1)", scope), 48);
});

test("expr: an absent name or field is null, a comparison on it is false, never an exception", () => {
  assert.equal(run("nothing.at.all", scope), null);
  assert.equal(run("trigger.missing > 1", scope), false);
  assert.equal(run("isnull(trigger.missing)", scope), true);
  assert.equal(run("coalesce(trigger.missing, 7)", scope), 7);
  assert.equal(run("1 / 0", scope), null);
});

test("expr: it reads own properties only, and the dangerous names are refused at parse time", () => {
  for (const bad of ["__proto__", "constructor", "trigger.constructor", "trigger.__proto__.x", "a.prototype"]) assert.throws(() => parse(bad), ExprError, bad);
  assert.equal(run("toString", scope), null);
  assert.equal(run("trigger.hasOwnProperty", scope), null);
});

test("expr: only the fixed functions can be called, and bad input is an error with a position", () => {
  assert.throws(() => parse("eval(\"1\")"), /not a function an expression may call/);
  assert.throws(() => parse("process.exit()"), ExprError);
  assert.throws(() => parse("a +"), /ends too soon/);
  assert.throws(() => parse("\"open"), /not closed/);
  assert.throws(() => parse("a $ b"), /unexpected character/);
  try { parse("a ? b"); assert.fail(); } catch (e) { assert.equal(e.at, 2); }
});

test("expr: limits hold: size, nesting and steps", () => {
  assert.throws(() => parse("1+".repeat(1200) + "1"), /at most/);
  assert.throws(() => parse("(".repeat(60) + "1" + ")".repeat(60)), /nested too deeply/);
  const big = "[" + Array(300).fill("1 + 1").join(",") + "]";
  assert.throws(() => parse(big), /too large/);
  const list = Array.from({ length: 6000 }, (_, i) => i);
  assert.throws(() => run("len(a) + len(b)", { a: list, b: list }) && run(Array(400).join("len(a)+") + "1", { a: list }), ExprError);
});

test("expr: roots and step references drive the compile check", () => {
  const n = parse("steps.find.rows[0].x == trigger.id and item.n > 1");
  assert.deepEqual([...roots(n)].sort(), ["item", "steps", "trigger"]);
  assert.deepEqual([...stepRefs(n)], ["find"]);
});

test("expr: date and datetime read a time as people do, in the zone given", () => {
  const at = Date.UTC(2026, 9, 14, 21, 0);
  const r = (src, extra = {}) => run(src, { at, tz: "America/Los_Angeles", ...extra });
  assert.equal(r("datetime(at, tz)"), "Wed 14 Oct, 2:00 pm");
  assert.equal(r("date(at, tz)"), "Wed 14 Oct");
  assert.equal(r("datetime(at, \"Asia/Karachi\")"), "Thu 15 Oct, 2:00 am");
  assert.equal(r("datetime(at)"), "Wed 14 Oct, 9:00 pm", "no zone reads as UTC");
  assert.equal(r("datetime(at, \"Nowhere/None\")"), "Wed 14 Oct, 9:00 pm", "an unknown zone reads as UTC");
  assert.equal(r("datetime(atText, tz)", { atText: String(at) }), "Wed 14 Oct, 2:00 pm", "a time in a string");
  assert.equal(r("datetime(\"2026-10-14T21:00:00Z\", tz)"), "Wed 14 Oct, 2:00 pm", "a date text");
  assert.equal(r("datetime(missing, tz)"), "", "a missing value is empty");
  assert.equal(r("datetime(\"soon\", tz)"), "soon", "something that is not a time keeps its own text");
  assert.equal(r("\"At \" + datetime(at, tz) + \".\""), "At Wed 14 Oct, 2:00 pm.");
});

const LA = "America/Los_Angeles";
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

test("expr: addtime moves a time by minutes and hours exactly, and by days, weeks and months on the wall clock", () => {
  const t = U(2026, 10, 31, 16); // Sat 31 Oct 9:00 am PDT
  assert.equal(run("addtime(t, 90, \"minutes\", z)", { t, z: LA }), t + 90 * 60_000);
  assert.equal(run("addtime(t, -2, \"hours\", z)", { t, z: LA }), t - 2 * 3_600_000);
  assert.equal(run("addtime(t, 1, \"day\", z)", { t, z: LA }), U(2026, 11, 1, 17), "9:00 am stays 9:00 am across the clocks going back: 25 hours later");
  assert.equal(run("addtime(t, 24, \"hours\", z)", { t, z: LA }), t + 24 * 3_600_000, "24 hours is exact");
  assert.equal(run("addtime(t, 2, \"weeks\", z)", { t, z: LA }), U(2026, 11, 14, 17));
  assert.equal(run("addtime(t, -1, \"days\", z)", { t, z: LA }), U(2026, 10, 30, 16));
  assert.equal(run("addtime(t, 1, \"days\")", { t }), t + 86_400_000, "no zone is UTC");
});

test("expr: addtime across a daylight saving change keeps the wall clock, moves a skipped time on by the gap and takes the first of a repeated one", () => {
  assert.equal(run("addtime(t, 1, \"day\", z)", { t: U(2026, 3, 7, 10, 30), z: LA }), U(2026, 3, 8, 10, 30), "2:30 am on 8 Mar does not exist: it is 3:30 am PDT");
  assert.equal(run("addtime(t, 1, \"day\", z)", { t: U(2026, 3, 7, 18), z: LA }), U(2026, 3, 8, 17), "10:00 am PST to 10:00 am PDT: 23 hours");
  assert.equal(run("addtime(t, 1, \"day\", z)", { t: U(2026, 10, 31, 8, 30), z: LA }), U(2026, 11, 1, 8, 30), "1:30 am on 1 Nov happens twice: the first");
  assert.equal(run("addtime(t, 1, \"months\", z)", { t: U(2026, 10, 15, 17), z: LA }), U(2026, 11, 15, 18), "a month across the change");
});

test("expr: addtime by months keeps a month end inside the month", () => {
  assert.equal(run("addtime(t, 1, \"months\")", { t: U(2026, 1, 31, 12) }), U(2026, 2, 28, 12));
  assert.equal(run("addtime(t, 1, \"months\")", { t: U(2028, 1, 31, 12) }), U(2028, 2, 29, 12), "a leap year");
  assert.equal(run("addtime(t, -1, \"months\")", { t: U(2026, 3, 31, 12) }), U(2026, 2, 28, 12));
  assert.equal(run("addtime(t, 2, \"months\")", { t: U(2026, 12, 15, 12) }), U(2027, 2, 15, 12), "across a year end");
  assert.equal(run("addtime(t, -14, \"months\")", { t: U(2026, 1, 20, 12) }), U(2024, 11, 20, 12));
  assert.equal(run("addtime(missing, 1, \"day\")", {}), null);
  assert.equal(run("addtime(t, 1, \"fortnights\")", { t: 0 }), null, "an unknown unit gives nothing rather than a wrong time");
  assert.equal(run("addtime(t, 1.5, \"days\")", { t: 0 }), null);
});

test("expr: format prints a time in named formats, in a zone, after an optional offset", () => {
  const t = U(2026, 10, 31, 16);
  assert.equal(run("format(t, \"date\", z)", { t, z: LA }), "31 Oct 2026");
  assert.equal(run("format(t, \"time\", z)", { t, z: LA }), "9:00 am");
  assert.equal(run("format(t, \"datetime\", z)", { t, z: LA }), "31 Oct 2026, 9:00 am");
  assert.equal(run("format(t, \"weekday\", z)", { t, z: LA }), "Sat 31 Oct");
  assert.equal(run("format(t, \"weekdaytime\", z)", { t, z: LA }), "Sat 31 Oct, 9:00 am");
  assert.equal(run("format(t, \"iso\", z)", { t, z: LA }), "2026-10-31T09:00:00-07:00");
  assert.equal(run("format(t, \"iso\", \"UTC\")", { t }), "2026-10-31T16:00:00Z");
  assert.equal(run("format(t, \"iso\", \"Asia/Karachi\")", { t }), "2026-10-31T21:00:00+05:00");
  assert.equal(run("format(t, \"weekdaytime\", z, 1, \"day\")", { t, z: LA }), "Sun 1 Nov, 9:00 am", "one day later, still 9:00 am");
  assert.equal(run("format(t, \"time\", z, -30, \"minutes\")", { t, z: LA }), "8:30 am");
  assert.equal(run("format(t, \"nonsense\", z)", { t, z: LA }), "31 Oct 2026, 9:00 am", "an unknown format is date and time");
  assert.equal(run("format(missing, \"date\", z)", { z: LA }), "");
  assert.equal(run("format(\"soon\", \"date\", z)", { z: LA }), "soon");
  assert.equal(run("format(t, \"time\", z, 1, \"parsec\")", { t, z: LA }), String(t), "an unknown unit leaves the time as it was given");
  assert.equal(run("format(t, \"time\", \"Nowhere/None\")", { t }), "4:00 pm", "an unknown zone is UTC");
});

test("expr: a move that leaves the range of a time gives nothing, never a wrong time", () => {
  assert.equal(run("addtime(t, 1, \"hours\")", { t: 8.64e15 }), null, "one hour past the last time");
  assert.equal(run("addtime(t, -1, \"days\")", { t: -8.64e15 }), null);
  assert.equal(run("addtime(t, 1000000000, \"months\")", { t: 0 }), null);
  assert.equal(run("addtime(t, 99999999999, \"weeks\")", { t: 0 }), null);
  assert.equal(run("format(t, \"date\", \"UTC\", 1, \"hours\")", { t: 8.64e15 }), String(8.64e15), "format leaves the time as given");
  assert.equal(run("addtime(t, 1, \"hours\")", { t: 8.64e15 - 3_600_000 }), 8.64e15, "the last time itself is fine");
});
