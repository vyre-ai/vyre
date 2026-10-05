// @ts-check
// lib/time at fixed moments: LA (UTC-7 in summer, -8 after 1 Nov 2026), Karachi (UTC+5, no DST), London (changes on 25 Oct).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolve, showTimes, zoneLabel, clock, timeLine, zoneFrom, personZone, scopeZone, ZONE_HEADER, toUTC, localParts } from "./index.js";

const LA = "America/Los_Angeles", KHI = "Asia/Karachi", NY = "America/New_York", LON = "Europe/London";
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);

test("time: showing a time as the space's and the person's, in the form the ruling gives", () => {
  const ten = Z(2026, 10, 5, 17); // 10:00 in Los Angeles, 22:00 in Karachi
  assert.equal(showTimes(ten, { person: KHI, space: LA }).text, "10:00 am PT · 10:00 pm your time");
  assert.equal(showTimes(ten, { person: LA, space: LA }).text, "10:00 am", "the same clock says it once");
  assert.equal(showTimes(ten, { person: KHI }).text, "10:00 pm", "a personal thing is only the person's clock");
  // a different day on one side says which
  const nine = Z(2026, 10, 6, 4); // 9:00 pm Mon in Los Angeles, 9:00 am Tue in Karachi
  assert.equal(showTimes(nine, { person: KHI, space: LA }).text, "9:00 pm PT · 9:00 am Tue your time");
  assert.deepEqual([showTimes(ten, { person: KHI, space: LA }).space, showTimes(ten, { person: KHI, space: LA }).person], ["10:00 am", "10:00 pm"]);
  // a zone two places that happen to agree at this instant (London and a UTC zone in winter) shows once
  assert.equal(showTimes(Z(2026, 12, 1, 12), { person: LON, space: "UTC" }).text, "12:00 pm");
  assert.equal(clock(Z(2026, 10, 5, 0, 5), "UTC"), "12:05 am");
  assert.equal(clock(Z(2026, 10, 5, 12, 0), "UTC"), "12:00 pm");
});

test("time: zone names are the short generic ones, with the offset as the last resort", () => {
  assert.equal(zoneLabel(LA, Z(2026, 7, 1)), "PT");
  assert.equal(zoneLabel(LA, Z(2026, 12, 1)), "PT", "the same name in winter: the label is the zone's, not the season's");
  assert.equal(zoneLabel(NY, Z(2026, 7, 1)), "ET");
  assert.ok(zoneLabel(KHI).length > 0);
});

test("time: a relative phrase is read on the wall of the zone, daylight saving included", () => {
  const now = Z(2026, 10, 31, 18); // 11:00 am Sat 31 Oct in Los Angeles (PDT), the night before the clocks go back
  const t = /** @type {any} */ (resolve("tomorrow at 9", { now, zone: LA }));
  assert.equal(t.date, "2026-11-01");
  assert.equal(t.wall, "09:00");
  assert.equal(t.at, Z(2026, 11, 1, 17), "9:00 am PST is 17:00 UTC: 25 hours on, not 24");
  // the same words in Karachi mean another instant
  const k = /** @type {any} */ (resolve("tomorrow at 9", { now, zone: KHI }));
  assert.equal(k.at, Z(2026, 11, 1, 4), "9:00 am Karachi is 04:00 UTC");
  assert.equal(/** @type {any} */ (resolve("tomorrow 9am", { now, zone: LA })).at, t.at);
  assert.equal(/** @type {any} */ (resolve("tomorrow at 3:30 pm", { now, zone: LA })).wall, "15:30");
  assert.equal(/** @type {any} */ (resolve("in 20 minutes", { now, zone: LA })).at, now + 20 * 60_000);
  assert.equal(/** @type {any} */ (resolve("in 2 hours", { now, zone: LA })).at, now + 2 * 3_600_000);
  // a day is a wall day: in a day from 11:00 am is 11:00 am the next day, over the change
  assert.equal(/** @type {any} */ (resolve("in 1 day", { now, zone: LA })).wall, "11:00");
  assert.equal(/** @type {any} */ (resolve("in 1 day", { now, zone: LA })).at, now + 25 * 3_600_000);
  assert.equal(/** @type {any} */ (resolve("next friday at 5pm", { now, zone: LA })).date, "2026-11-06");
  assert.equal(/** @type {any} */ (resolve("friday", { now, zone: LA })).wall, "09:00", "no time says the default morning");
  assert.equal(/** @type {any} */ (resolve("tonight", { now, zone: LA })).wall, "20:00");
  assert.equal(/** @type {any} */ (resolve("2026-12-25 at 8am", { now, zone: NY })).at, Z(2026, 12, 25, 13));
  assert.equal(/** @type {any} */ (resolve("noon", { now, zone: LA })).wall, "12:00");
  // a clock alone is the next time it comes round
  assert.equal(/** @type {any} */ (resolve("9am", { now, zone: LA })).date, "2026-11-01", "9:00 am has passed today (it is 11:00 am), so tomorrow");
  assert.equal(/** @type {any} */ (resolve("5pm", { now, zone: LA })).date, "2026-10-31");
});

test("time: a phrase that does not say is ambiguous, and words it does not read are null", () => {
  const now = Z(2026, 10, 5, 12);
  assert.deepEqual(Object.keys(/** @type {any} */ (resolve("tomorrow at 5", { now, zone: LA }))).sort(), ["ambiguous", "reason"]);
  assert.match(/** @type {any} */ (resolve("5", { now, zone: LA })).reason, /am or pm/);
  assert.equal(resolve("whenever", { now, zone: LA }), null);
  assert.equal(resolve("", { now, zone: LA }), null);
  assert.equal(/** @type {any} */ (resolve("tomorrow at 17:45", { now, zone: LA })).wall, "17:45");
});

test("time: the person's zone comes from the calling device, only if it is a real zone", () => {
  assert.equal(ZONE_HEADER, "x-vyre-zone");
  assert.equal(zoneFrom("Asia/Karachi"), "Asia/Karachi");
  assert.equal(zoneFrom("Mars/Olympus", "UTC"), "UTC");
  assert.equal(zoneFrom({}, "UTC"), "UTC");
  assert.equal(zoneFrom("x".repeat(100), "UTC"), "UTC");
  assert.equal(personZone({ zone: "Europe/London" }, "Asia/Karachi", "UTC"), "Europe/London", "the device in use wins: it follows them when they travel");
  assert.equal(personZone({}, "Asia/Karachi", "UTC"), "Asia/Karachi", "else the zone they set");
  assert.equal(personZone({ zone: "nonsense" }, "also nonsense", "UTC"), "UTC");
});

test("time: a personal thing is the person's zone, a space's thing the space's, and an unclear one the space's with both said", () => {
  assert.deepEqual(scopeZone({ scope: "personal", person: KHI, space: LA }), { zone: KHI, scope: "personal", both: false });
  assert.deepEqual(scopeZone({ scope: "space", person: KHI, space: LA }), { zone: LA, scope: "space", both: true });
  assert.deepEqual(scopeZone({ person: KHI, space: LA }), { zone: LA, scope: "space", both: true });
  assert.deepEqual(scopeZone({ person: KHI, space: KHI }), { zone: KHI, scope: "space", both: false });
  assert.deepEqual(scopeZone({ person: KHI, space: null }), { zone: KHI, scope: "personal", both: false });
});

test("time: the line every model brief carries", () => {
  const now = Z(2026, 10, 5, 17);
  const line = timeLine({ now, person: KHI, space: LA, contacts: [{ name: "Dana Wine", zone: NY }, { name: "Nobody", zone: "Mars/Olympus" }] });
  assert.match(line, /Mon 5 Oct 2026, 10:00 pm for the person \(Asia\/Karachi\)/);
  assert.match(line, /This space keeps America\/Los_Angeles, where it is Mon 5 Oct 2026, 10:00 am/);
  assert.match(line, /Dana Wine is in America\/New_York, where it is 1:00 pm/);
  assert.ok(!line.includes("Nobody"), "a zone that is not one is left out");
  assert.match(line, /use the space's zone and say both/);
  assert.doesNotMatch(timeLine({ now, person: KHI }), /space/i, "no space, no space line");
});

test("time: the zone functions are the same ones the planner uses, and a daily 07:00 stays 07:00 over a change", () => {
  assert.equal(toUTC({ year: 2026, month: 11, day: 1 }, { hour: 9, minute: 0 }, LA), Z(2026, 11, 1, 17));
  assert.equal(localParts(Z(2026, 11, 1, 17), LA).hour, 9);
});
