// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, EARLY_MIN } from "./match.js";

const T0 = Date.parse("2026-10-01T09:00:00-07:00");
const MIN = 60_000;
const base = (o = {}) => ({
  kind: "send", channel: "email", to_ids: ["c_priya"], standing: false,
  when: { at: null, window_minutes: 120 },
  limits: { amount_max: null, currency: null, count: null, until: null },
  created_at: T0, revoked: null, ...o,
});
const call = (o = {}) => ({ kind: "send", channel: "email", to_ids: ["c_priya"], at: T0 + 5 * MIN, ...o });

test("a call inside the ask matches", () => {
  assert.equal(matches(base(), call()), true);
});

test("revoked, other kind, other channel or a null to_ids never match", () => {
  assert.equal(matches(base({ revoked: 1 }), call()), false);
  assert.equal(matches(base(), call({ kind: "post" })), false);
  assert.equal(matches(base(), call({ channel: "sms" })), false);
  assert.equal(matches(base({ to_ids: null }), call()), false);
  assert.equal(matches(base({ channel: null }), call({ channel: "sms" })), true);
});

test("every call recipient must be one the person named", () => {
  assert.equal(matches(base(), call({ to_ids: ["c_priya", "c_quinn"] })), false);
  assert.equal(matches(base({ to_ids: ["c_priya", "c_jordan"] }), call({ to_ids: ["c_jordan"] })), true);
  assert.equal(matches(base({ to_ids: ["jordan@harlow.example"] }), call({ to_ids: ["Jordan@Harlow.example"] })), true);
  assert.equal(matches(base({ to_ids: [] }), call({ to_ids: ["c_priya"] })), false);
});

test("a one-off ask holds for its window, from ten minutes before", () => {
  assert.equal(matches(base(), call({ at: T0 - (EARLY_MIN - 1) * MIN })), true);
  assert.equal(matches(base(), call({ at: T0 - (EARLY_MIN + 1) * MIN })), false);
  assert.equal(matches(base(), call({ at: T0 + 120 * MIN })), true);
  assert.equal(matches(base(), call({ at: T0 + 121 * MIN })), false);
});

test("a scheduled ask holds around its time, not around when it was asked", () => {
  const at = "2026-10-02T08:00:00-07:00";
  const i = base({ when: { at, window_minutes: 30 } });
  assert.equal(matches(i, call({ at: T0 + 5 * MIN })), false);
  assert.equal(matches(i, call({ at: Date.parse(at) + 20 * MIN })), true);
  assert.equal(matches(i, call({ at: Date.parse(at) + 31 * MIN })), false);
  assert.equal(matches(base({ when: { at: "garbage", window_minutes: 30 } }), call()), false);
});

test("the call time defaults to now", () => {
  assert.equal(matches(base(), call({ at: undefined }), { now: T0 + 60 * MIN }), true);
  assert.equal(matches(base(), call({ at: undefined }), { now: T0 + 300 * MIN }), false);
});

test("a one-off ask covers one call per named recipient", () => {
  assert.equal(matches(base(), call(), { used: 1 }), false);
  const two = base({ to_ids: ["c_priya", "c_jordan"] });
  assert.equal(matches(two, call(), { used: 1 }), true);
  assert.equal(matches(two, call(), { used: 2 }), false);
});

test("a payment matches only up to the amount, in the currency", () => {
  const p = base({ kind: "pay", channel: null, to_ids: ["c_northwind"], limits: { amount_max: 180, currency: "USD", count: null, until: null } });
  const c = o => call({ kind: "pay", channel: null, to_ids: ["c_northwind"], amount: 180, currency: "usd", ...o });
  assert.equal(matches(p, c()), true);
  assert.equal(matches(p, c({ amount: 120 })), true);
  assert.equal(matches(p, c({ amount: 180.01 })), false);
  assert.equal(matches(p, c({ currency: "EUR" })), false);
  assert.equal(matches(p, c({ amount: undefined })), false);
  assert.equal(matches(p, c({ amount: -5 })), false);
  assert.equal(matches(base({ kind: "pay", channel: null, to_ids: ["c_northwind"] }), c()), false);
});

test("a standing permission holds until its end and for its count", () => {
  const s = base({ standing: true, limits: { amount_max: null, currency: null, count: 3, until: "2026-12-31T23:59:00-08:00" } });
  assert.equal(matches(s, call({ at: Date.parse("2026-11-15T10:00:00-08:00") }), { used: 2 }), true);
  assert.equal(matches(s, call({ at: Date.parse("2026-11-15T10:00:00-08:00") }), { used: 3 }), false);
  assert.equal(matches(s, call({ at: Date.parse("2027-01-01T10:00:00-08:00") })), false);
  assert.equal(matches(s, call({ at: T0 - 60 * MIN })), false);
  const open = base({ standing: true });
  assert.equal(matches(open, call({ at: T0 + 200 * 86_400_000 }), { used: 500 }), true);
  assert.equal(matches(base({ standing: true, limits: { until: "whenever" } }), call()), false);
});

test("missing pieces answer false, never throw", () => {
  const any = /** @type {any} */ (null);
  assert.equal(matches(any, call()), false);
  assert.equal(matches(base({ created_at: any }), call()), false);
  assert.equal(matches(base(), /** @type {any} */ ({ kind: "send", channel: "email" })), false);
});

test("an empty recipient list never matches, on either side", () => {
  const base = { kind: "send", channel: "email", to_ids: ["priya@harlowlegal.example"], created_at: 1_000_000 };
  assert.equal(matches(base, { kind: "send", channel: "email", to_ids: [], at: 1_000_000 }), false);
  assert.equal(matches({ ...base, to_ids: [] }, { kind: "send", channel: "email", to_ids: [], at: 1_000_000 }), false);
  assert.equal(matches({ ...base, standing: true, to_ids: [] }, { kind: "send", channel: "email", to_ids: [], at: 1_000_000 }), false);
});

test("a standing permission never covers a call from before it was given", () => {
  const i = { kind: "post", channel: "slack", to_ids: ["#deploys"], standing: true, created_at: 10 * 60_000 };
  assert.equal(matches(i, { kind: "post", channel: "slack", to_ids: ["#deploys"], at: 10 * 60_000 - 1 }), false);
  assert.equal(matches(i, { kind: "post", channel: "slack", to_ids: ["#deploys"], at: 10 * 60_000 }), true);
});
