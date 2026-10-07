import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { theirTimeOf, timeOf, timeLineOf, dayOf, dayTimeOf, stampOf, hourOf } from "./show.js";

const AT = Date.UTC(2026, 9, 6, 16, 0); // 16:00 UTC, 6 Oct 2026
test("every time is read by lib/time in a zone the caller names: the viewer's clock, the space's too, a day, a day with its time", () => {
  assert.equal(timeOf(AT, "Asia/Karachi"), "9:00 pm");
  assert.equal(timeLineOf(AT, "America/Los_Angeles", "Asia/Karachi"), "9:00 am PT · 9:00 pm your time");
  assert.equal(timeLineOf(AT, null, "Asia/Karachi"), "9:00 pm");
  assert.equal(dayOf(AT, { zone: "Asia/Karachi" }), "6 Oct 2026");
  assert.equal(dayOf(AT, { zone: "Asia/Karachi", year: false }), "6 Oct");
  assert.equal(dayTimeOf(AT, { zone: "Asia/Karachi", now: Date.UTC(2026, 0, 1) }), "6 Oct, 9:00 pm");
  assert.equal(dayTimeOf(AT, { zone: "Asia/Karachi", now: Date.UTC(2027, 0, 1) }), "6 Oct 2026, 9:00 pm");
  assert.equal(stampOf(AT, "Asia/Karachi"), "Tue 6 Oct 2026, 9:00 pm");
  assert.equal(hourOf(AT, "Asia/Karachi"), 21);
});

test("a contact's local time comes from the Contact's time_zone through lib/time; no zone or a made-up one shows nothing", () => {
  assert.equal(theirTimeOf(AT, "America/Los_Angeles"), "9:00 am PT");
  assert.equal(theirTimeOf(AT, "Asia/Karachi"), "9:00 pm GMT+5");
  assert.equal(theirTimeOf(AT, ""), null);
  assert.equal(theirTimeOf(AT, "Mars/Olympus"), null);
  assert.equal(theirTimeOf(AT, undefined), null);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
test("no screen formats a time by itself: every display goes through lib/time (the form inputs and the hidden Glass are the exceptions)", () => {
  const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".expo"].includes(e.name) || e.name.startsWith("dist")) continue;
      const p = path.join(dir, e.name), rel = path.relative(APP, p);
      if (e.isDirectory()) { if (!["src/chat/core", "screens/glass"].includes(rel)) walk(p); continue; }
      if (!/\.(ts|tsx|js)$/.test(e.name) || /\.test\./.test(e.name) || rel === "src/time/show.js" || rel === "ui/fields/logic.js") continue;
      if (/toLocale(Time|Date)String|\.getHours\(|\.getMinutes\(/.test(fs.readFileSync(p, "utf8"))) bad.push(rel);
    }
  };
  walk(path.join(APP, "screens")); walk(path.join(APP, "src")); walk(path.join(APP, "ui"));
  assert.deepEqual(bad, [], "these format a time by hand");
});
