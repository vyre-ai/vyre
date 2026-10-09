// @ts-check
// The governor keeps a real account safe: a person's pace, daily caps, quiet hours, one challenge stops it for good until a person resumes it. Every number is a setting per account.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernor, settingsOf, profileFor, inQuiet, localParts, isChallenge, STRICT } from "./governor.js";

const mem = () => { /** @type {Map<string, any>} */ const m = new Map(); return { get: (/** @type {string} */ id) => m.get(id) ?? null, put: (/** @type {string} */ id, /** @type {any} */ s) => void m.set(id, { ...s }) }; };
const at = (/** @type {string} */ iso) => Date.parse(iso);
/** a governor on a settable clock, with jitter fixed at the middle of the range */
function rig(start = "2026-10-12T10:00:00Z", own = {}) {
  const clock = { t: at(start) };
  const settings = /** @type {NonNullable<ReturnType<typeof settingsOf>>} */ (settingsOf("www.linkedin.com", { tz: "UTC", ...own }));
  const gov = createGovernor({ store: mem(), now: () => clock.t, random: () => 0.5 });
  return { clock, settings, gov, admit: (kind = "read") => gov.admit({ id: "li", kind, settings }), record: (cls = "ok", reason = "", kind = "read") => gov.record({ id: "li", kind, settings, cls, reason }) };
}

test("a watched site gets the strict profile by default and every number is a setting; a site nobody watches is not governed unless the person says so", () => {
  assert.equal(profileFor("www.linkedin.com"), "strict"); assert.equal(profileFor("linkedin.com"), "strict"); assert.equal(profileFor("app.example.com"), "none");
  const d = /** @type {any} */ (settingsOf("www.linkedin.com", { tz: "UTC" }));
  assert.deepEqual([d.reads_per_day, d.writes_per_day, d.gap_read_s, d.gap_write_s, d.quiet], [STRICT.reads_per_day, STRICT.writes_per_day, STRICT.gap_read_s, STRICT.gap_write_s, STRICT.quiet]);
  const own = /** @type {any} */ (settingsOf("www.linkedin.com", { tz: "Europe/Paris", reads_per_day: 120, gap_read_s: [10, 20], quiet: null, bogus: 1 }));
  assert.deepEqual([own.reads_per_day, own.gap_read_s, own.quiet, own.tz, own.writes_per_day], [120, [10, 20], null, "Europe/Paris", 15], "the person's numbers over the profile's, the rest left as they were");
  assert.equal(settingsOf("app.example.com", {}), null);
  const opted = /** @type {any} */ (settingsOf("app.example.com", { writes_per_day: 5, tz: "UTC" }));
  assert.equal(opted.writes_per_day, 5); assert.equal(opted.quiet, null);
  assert.equal(settingsOf("www.linkedin.com", { profile: "none" }), null, "the person may turn it off for their own account");
  assert.deepEqual(/** @type {any} */ (settingsOf("www.linkedin.com", { gap_read_s: [90, 10], tz: "UTC" })).gap_read_s, [90, 90], "a nonsense range cannot go backwards");
});

test("pace: calls are spaced like a person's, and a wait that is too long is a plain refusal, not a sleep", () => {
  const r = rig();
  assert.deepEqual(r.admit(), { ok: true, waitMs: 0 });
  r.record("ok");
  r.clock.t += 10_000;
  const w = /** @type {any} */ (r.admit());
  assert.equal(w.ok, true); assert.equal(w.waitMs, 30_000, "the middle of 20-60 s is 40 s, 10 s have passed");
  r.clock.t += 31_000;
  assert.equal(/** @type {any} */ (r.admit()).waitMs, 0);
  // a write is paced on its own, longer gap
  r.record("ok", "", "send");
  const wr = /** @type {any} */ (r.admit("send"));
  assert.equal(wr.ok, false); assert.equal(wr.class, "rate"); assert.match(wr.reason, /pacing: the next call is allowed in 2\d\d s/);
});

test("daily caps are counted apart for reads and writes and roll over at the account's local midnight", () => {
  const r = rig("2026-10-12T10:00:00Z", { reads_per_day: 3, writes_per_day: 1, gap_read_s: [0, 0], gap_write_s: [0, 0], quiet: null });
  for (let i = 0; i < 3; i++) { assert.equal(r.admit().ok, true); r.record("ok"); }
  const full = /** @type {any} */ (r.admit());
  assert.equal(full.ok, false); assert.equal(full.class, "rate"); assert.match(full.reason, /daily limit of 3 reads/);
  assert.equal(r.admit("send").ok, true, "writes have their own count");
  r.record("ok", "", "send");
  assert.match(/** @type {any} */ (r.admit("send")).reason, /daily limit of 1 writes/);
  r.clock.t = at("2026-10-13T00:00:30Z");
  assert.equal(r.admit().ok, true, "a new day");
  assert.deepEqual([r.gov.usage("li", r.settings).reads, r.gov.usage("li", r.settings).writes], [0, 0]);
  // another time zone has its midnight elsewhere
  const paris = rig("2026-10-12T21:30:00Z", { tz: "Europe/Paris", reads_per_day: 1, gap_read_s: [0, 0], quiet: null });
  paris.record("ok");
  assert.equal(paris.admit().ok, false);
  paris.clock.t = at("2026-10-12T22:30:00Z");
  assert.equal(paris.admit().ok, true, "00:30 in Paris is the next day");
});

test("quiet hours: nothing is sent at night, local to the account, across midnight", () => {
  assert.equal(inQuiet(23 * 60, { from: "22:00", to: "07:00" }), true);
  assert.equal(inQuiet(3 * 60, { from: "22:00", to: "07:00" }), true);
  assert.equal(inQuiet(7 * 60, { from: "22:00", to: "07:00" }), false);
  assert.equal(inQuiet(12 * 60, { from: "22:00", to: "07:00" }), false);
  assert.equal(inQuiet(60, { from: "00:00", to: "00:00" }), false, "an empty window is no window");
  const night = rig("2026-10-12T02:15:00Z");
  const refused = /** @type {any} */ (night.admit());
  assert.equal(refused.ok, false); assert.match(refused.reason, /quiet hours: no calls until 07:00 \(UTC\)/);
  assert.equal(rig("2026-10-12T02:15:00Z", { quiet: null }).admit().ok, true, "the person can have no quiet hours");
  assert.deepEqual(localParts(at("2026-10-12T22:30:00Z"), "Europe/Paris"), { day: "2026-10-13", minutes: 30 });
});

test("the first challenge stops the account and it stays stopped, across restarts of the day, until a person resumes it", () => {
  const r = rig();
  assert.equal(isChallenge("blocked", "Checkpoint challenge page (HTTP 200)"), true);
  assert.equal(isChallenge("blocked", "HTTP 403 with no login or challenge markers: This profile can't be accessed"), false, "one entity refused is not a challenge");
  assert.equal(isChallenge("auth", "challenge"), false);
  r.record("blocked", "HTTP 403 with no login or challenge markers: no");
  assert.equal(r.admit().ok, true, "a refused profile does not stop the account");
  r.clock.t += 120_000;
  const rec = r.record("blocked", "Checkpoint challenge page (HTTP 200)");
  assert.equal(rec.stopped, true);
  r.clock.t += 3 * 86_400_000;
  const stopped = /** @type {any} */ (r.admit());
  assert.equal(stopped.ok, false); assert.equal(stopped.class, "blocked");
  assert.match(stopped.reason, /stopped after a challenge/);
  assert.equal(r.gov.usage("li", r.settings).stopped, true);
  assert.equal(r.gov.resume("li"), true);
  assert.equal(r.admit().ok, true, "a person said so");
  assert.equal(r.gov.resume("nobody"), false);
});

test("a slowdown from the site starts a cooldown; a call that never reached the site used none of the day", () => {
  const r = rig("2026-10-12T10:00:00Z", { cooldown_min: 30, gap_read_s: [0, 0], quiet: null });
  for (const cls of ["input", "held", "no_browser"]) r.record(cls);
  assert.equal(r.gov.usage("li", r.settings).reads, 0);
  r.record("rate", "HTTP 429");
  const cool = /** @type {any} */ (r.admit());
  assert.equal(cool.ok, false); assert.match(cool.reason, /cooling down after the site said to slow down, until 10:30/);
  r.clock.t += 31 * 60_000;
  assert.equal(r.admit().ok, true);
});
