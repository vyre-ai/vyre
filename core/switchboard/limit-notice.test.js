// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "./translate.js";
import { limitFrom, limitNotice, resetWhen, zoneOf } from "./limit-notice.js";
import { localParts } from "../../lib/time/zones.js";

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RESETS = 1790000000;

test("two windows in one rate-limit event each keep their own utilization, and the reset is in the person's zone", () => {
  // The top-level utilization is the Opus window's 95%. The named window is the overall weekly one, whose own figure is 85%.
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.95,
      resetsAt: RESETS,
      five_hour: { utilization: 0.2, resetsAt: RESETS },
      seven_day: { utilization: 0.85, resetsAt: RESETS },
      seven_day_opus: { utilization: 0.95, resetsAt: RESETS + 3600 },
    },
  };
  const limit = translate(event).limit;
  assert.equal(limit.kind, "seven_day");
  assert.equal(limit.utilization, 0.85, "the named window's own percentage, not the other window's");
  assert.equal(limit.status, "allowed_warning");
  assert.equal(limit.windows.length, 3);
  assert.equal(limit.windows.find((/** @type {any} */ w) => w.kind === "seven_day").utilization, 0.85);
  assert.equal(limit.windows.find((/** @type {any} */ w) => w.kind === "seven_day_opus").utilization, 0.95);

  const zone = "Asia/Kuala_Lumpur";
  const text = limitNotice(limit, zone);
  assert.match(text, /Claude's overall weekly usage limit is at 85%/);
  assert.match(text, /Claude's Opus weekly usage limit is at 95%/);
  assert.doesNotMatch(text, /overall weekly usage limit is at 95%/);
  assert.doesNotMatch(text, /Opus weekly usage limit is at 85%/);
  assert.doesNotMatch(text, /five-hour/, "a window under 80% is not said");
  assert.doesNotMatch(text, /UTC/);
  const weekly = localParts(RESETS * 1000, zone);
  const opus = localParts((RESETS + 3600) * 1000, zone);
  const clock = (/** @type {any} */ p) => `${WEEK[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  assert.match(text, new RegExp(`overall weekly usage limit is at 85%; it resets ${clock(weekly).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(text, new RegExp(`Opus weekly usage limit is at 95%; it resets ${clock(opus).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(text, limitNotice(limitFrom(event.rate_limit_info), zone));
});

test("a single window keeps the old shape, and a reset with no zone is left off", () => {
  const one = translate({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: RESETS, utilization: 0.85 } });
  assert.deepEqual(one.limit, { status: "allowed_warning", kind: "five_hour", resets_at: RESETS, utilization: 0.85 });
  assert.equal(limitNotice(one.limit, null), "Claude's five-hour usage limit is at 85%.");
  assert.equal(resetWhen(RESETS, "Not/AZone"), "");
  assert.equal(zoneOf({ tz: "Asia/Karachi", opts: JSON.stringify({ zone: "UTC" }) }), "Asia/Karachi");
  assert.equal(zoneOf({ tz: null, opts: JSON.stringify({ zone: "Asia/Karachi" }) }), "Asia/Karachi");
  assert.equal(zoneOf({ tz: "nope", opts: "{}" }), null);
  const reached = limitNotice({ status: "rejected", kind: "seven_day_sonnet", resets_at: RESETS, utilization: 1 }, "UTC");
  assert.match(reached, /^Claude's Sonnet weekly usage limit is reached; it resets /);
});
