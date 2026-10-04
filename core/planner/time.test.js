// @ts-check
// Zone math at fixed moments: Karachi (UTC+5, no DST), New York across both of its 2026 changes
// (08 Mar 02:00 skips to 03:00, 01 Nov 02:00 goes back to 01:00) and London across its own
// (29 Mar, 25 Oct).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toUTC, localParts, offset, nextOccurrence, checkRepeat, parseDate, parseWall } from "./time.js";

const KHI = "Asia/Karachi", NY = "America/New_York", LON = "Europe/London";
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const d = s => /** @type {any} */ (parseDate(s)), w = s => /** @type {any} */ (parseWall(s));

test("time: a wall time in a zone to UTC and back", () => {
  assert.equal(toUTC(d("2026-09-25"), w("07:00"), KHI), Z(2026, 9, 25, 2));
  assert.equal(offset(Z(2026, 9, 25), KHI), 5 * 3600_000);
  const p = localParts(Z(2026, 9, 24, 19, 30), KHI);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 9, 25, 0, 30, 5], "past midnight in Karachi is Friday");
  assert.equal(toUTC(d("2026-07-01"), w("12:00"), NY), Z(2026, 7, 1, 16));
  assert.equal(toUTC(d("2026-01-15"), w("12:00"), NY), Z(2026, 1, 15, 17));
});

test("time: the spring gap moves forward, the autumn repeat takes the first", () => {
  // New York, 8 Mar: 02:30 does not exist; it reads as 03:30 EDT.
  assert.equal(toUTC(d("2026-03-08"), w("02:30"), NY), Z(2026, 3, 8, 7, 30));
  assert.equal(toUTC(d("2026-03-08"), w("01:30"), NY), Z(2026, 3, 8, 6, 30), "before the gap, EST");
  assert.equal(toUTC(d("2026-03-08"), w("03:30"), NY), Z(2026, 3, 8, 7, 30), "after the gap, EDT");
  // New York, 1 Nov: 01:30 happens twice; the first is EDT.
  assert.equal(toUTC(d("2026-11-01"), w("01:30"), NY), Z(2026, 11, 1, 5, 30));
  assert.equal(toUTC(d("2026-11-01"), w("03:00"), NY), Z(2026, 11, 1, 8), "after the change, EST");
  // London: 29 Mar 01:30 is skipped (02:30 BST); 25 Oct 01:30 twice, first in BST.
  assert.equal(toUTC(d("2026-03-29"), w("01:30"), LON), Z(2026, 3, 29, 1, 30));
  assert.equal(localParts(Z(2026, 3, 29, 1, 30), LON).hour, 2);
  assert.equal(toUTC(d("2026-10-25"), w("01:30"), LON), Z(2026, 10, 25, 0, 30));
  assert.equal(toUTC(d("2026-10-25"), w("09:00"), LON), Z(2026, 10, 25, 9));
});

test("time: a daily 07:00 stays 07:00 local through both New York changes", () => {
  const rule = checkRepeat({ every: "day", start: "2026-03-01" });
  let t = Z(2026, 3, 1);
  const seen = [];
  for (let i = 0; i < 250; i++) {
    const n = /** @type {number} */ (nextOccurrence({ wall: "07:00", tz: NY, after: t, repeat: rule }));
    const p = localParts(n, NY);
    assert.equal(`${p.hour}:${p.minute}`, "7:0", new Date(n).toISOString());
    seen.push(n);
    t = n;
  }
  const gaps = new Set(seen.slice(1).map((n, i) => (n - seen[i]) / 3600_000));
  assert.deepEqual([...gaps].sort(), [23, 24, 25], "one short day in March, one long day in November");
  assert.equal(seen.find(n => n > Z(2026, 3, 8)), Z(2026, 3, 8, 11), "07:00 EDT on the day of the change");
  assert.equal(seen.find(n => n > Z(2026, 11, 1)), Z(2026, 11, 1, 12), "07:00 EST on the day it ends");
  // In London too.
  const lon = nextOccurrence({ wall: "07:00", tz: LON, after: Z(2026, 10, 24, 12), repeat: checkRepeat({ every: "day" }) });
  assert.equal(lon, Z(2026, 10, 25, 7));
});

test("time: repeat rules: weekdays, chosen days every other week, month ends, leap days and until", () => {
  const fri = Z(2026, 9, 25, 3); // Friday 08:00 in Karachi
  assert.equal(nextOccurrence({ wall: "06:00", tz: KHI, after: fri, repeat: checkRepeat({ every: "weekday" }) }), Z(2026, 9, 28, 1), "Friday's 06:00 has passed; Monday");
  assert.equal(nextOccurrence({ wall: "09:00", tz: KHI, after: fri, repeat: checkRepeat({ every: "weekday" }) }), Z(2026, 9, 25, 4), "later on Friday");
  // Mondays and Thursdays every other week, from the week of Mon 21 Sep.
  const r = checkRepeat({ every: "week", days: [1, 4], interval: 2, start: "2026-09-21" });
  const hits = [];
  let t = Z(2026, 9, 20);
  for (let i = 0; i < 4; i++) { t = /** @type {number} */ (nextOccurrence({ wall: "10:00", tz: KHI, after: t, repeat: r })); hits.push(new Date(t).toISOString().slice(0, 10)); }
  assert.deepEqual(hits, ["2026-09-21", "2026-09-24", "2026-10-05", "2026-10-08"]);
  // The 31st rings on the last day of a shorter month.
  const m = checkRepeat({ every: "month", start: "2026-01-31" });
  assert.equal(nextOccurrence({ wall: "12:00", tz: "UTC", after: Z(2026, 2, 1), repeat: m }), Z(2026, 2, 28, 12));
  assert.equal(nextOccurrence({ wall: "12:00", tz: "UTC", after: Z(2026, 3, 1), repeat: m }), Z(2026, 3, 31, 12));
  const y = checkRepeat({ every: "year", start: "2028-02-29" });
  assert.equal(nextOccurrence({ wall: "08:00", tz: "UTC", after: Z(2028, 3, 1), repeat: y }), Z(2029, 2, 28, 8));
  const until = checkRepeat({ every: "day", until: "2026-09-26" });
  assert.equal(nextOccurrence({ wall: "07:00", tz: KHI, after: Z(2026, 9, 25, 3), repeat: until }), Z(2026, 9, 26, 2));
  assert.equal(nextOccurrence({ wall: "07:00", tz: KHI, after: Z(2026, 9, 26, 3), repeat: until }), null, "the rule has ended");
  assert.equal(nextOccurrence({ wall: "07:00", tz: KHI, after: Z(2026, 9, 25, 3) }), Z(2026, 9, 26, 2), "no rule: the next 07:00");
  assert.throws(() => checkRepeat({ every: "fortnight" }), /repeat.every/);
  assert.throws(() => checkRepeat({ every: "week", days: [7] }), /weekdays/);
  assert.equal(parseWall("24:00"), null);
  assert.equal(parseDate("2026-02-30"), null);
});
