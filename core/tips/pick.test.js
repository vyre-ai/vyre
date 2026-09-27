// @ts-check
// The selection rules, one by one, on plain data: no store, no clock, no daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pick } from "./pick.js";
import { checkTips } from "./check.js";

const MIN = 60_000, HOUR = 60 * MIN;
const T = 1_800_000_000_000;

/** Tips for a small sample world: planner and vault in use, recall never opened. */
const raw = {
  planner: [
    { id: "remind", text: "Type `vyre remind 5pm call juno` to set a reminder.", surfaces: ["cli", "deck"], level: "first-use", trigger: "on-use", since: "0.1.0" },
    { id: "snooze", text: "Press `s` on a ringing alarm to snooze it 10 minutes.", surfaces: ["deck"], level: "power", trigger: "on-use", since: "0.1.0", key: "s" },
    { id: "agenda", text: "Run `vyre agenda` for today in one screen.", surfaces: ["cli", "deck"], level: "power", trigger: "idle", since: "0.1.0" },
    { id: "new-sync", text: "Your calendar now syncs both ways.", surfaces: ["deck"], level: "discovery", trigger: "after-update", since: "0.2.0" },
  ],
  recall: [
    { id: "try", text: "Ask `vyre recall the Harlow Legal brief` to find last week's work.", surfaces: ["cli", "deck"], level: "discovery", trigger: "never-used", since: "0.1.0" },
  ],
  vault: [
    { id: "try", text: "Keep a key in the vault with `vyre vault add`.", surfaces: ["deck"], level: "discovery", trigger: "never-used", since: "0.1.0" },
  ],
};
const tips = Object.entries(raw).flatMap(([m, t]) => checkTips(m, t).tips);

/** @param {any} [over] */
const base = (over = {}) => ({
  tips, surface: "deck", context: {}, now: T, settings: {},
  shown: new Map(), used: new Map([["planner", 1]]), log: [], lastTipAt: new Map(),
  running: () => "0.1.0", seenVersion: () => "0.1.0", ...over,
});
const id = (/** @type {any} */ r) => r.tip && r.tip.id;

test("tips: off in the hub means no tip, whatever else holds", () => {
  assert.deepEqual(pick(base({ settings: { enabled: false }, context: { module: "planner" } })), { tip: null, why: "off" });
});

test("tips: never while an ask, a prompt or a turn is on screen", () => {
  assert.equal(pick(base({ context: { module: "planner", busy: true, idle: true } })).why, "busy");
});

test("tips: the module the person is in comes first, first-use while new to it", () => {
  const r = pick(base({ context: { module: "planner", idle: true } }));
  assert.equal(id(r), "planner/remind");
  assert.equal(r.why, "current");
});

test("tips: after three uses, power tips come before first-use ones", () => {
  assert.equal(id(pick(base({ used: new Map([["planner", 3]]), context: { module: "planner" } }))), "planner/snooze");
});

test("tips: only tips for this surface", () => {
  // snooze is Deck-only; on the CLI a power user gets the first-use tip that names the CLI.
  assert.equal(id(pick(base({ surface: "cli", used: new Map([["planner", 5]]), context: { module: "planner" } }))), "planner/remind");
});

test("tips: without idle, nothing but the current module", () => {
  assert.equal(pick(base({ context: {} })).why, "none");
});

test("tips: when idle, a module never used, the one that went longest without a tip first", () => {
  assert.equal(id(pick(base({ context: { idle: true } }))), "recall/try"); // by name when neither had one
  assert.equal(id(pick(base({ context: { idle: true }, lastTipAt: new Map([["recall", T - HOUR]]) }))), "vault/try");
});

test("tips: a used module gets no never-used tip", () => {
  assert.equal(id(pick(base({ context: { idle: true }, used: new Map([["planner", 1], ["recall", 1], ["vault", 2]]) }))), "planner/agenda");
});

test("tips: after an update, tips newer than the version last seen, then idle tips", () => {
  const used = new Map([["planner", 1], ["recall", 1], ["vault", 1]]);
  const r = pick(base({ context: { idle: true }, used, running: () => "0.2.0", seenVersion: () => "0.1.0" }));
  assert.equal(id(r), "planner/new-sync");
  assert.equal(r.why, "update");
  // Not yet released on this install: never shown.
  assert.equal(id(pick(base({ context: { idle: true }, used }))), "planner/agenda");
});

test("tips: a first start (no seen version) offers no what's new", () => {
  const used = new Map([["planner", 1], ["recall", 1], ["vault", 1]]);
  assert.equal(id(pick(base({ context: { idle: true }, used, running: () => "0.2.0", seenVersion: () => null }))), "planner/agenda");
});

test("tips: one per surface per gap; another surface is not held by it after the spread", () => {
  const log = [{ surface: "deck", at: T - 10 * MIN }];
  assert.equal(pick(base({ log, context: { module: "planner" } })).why, "gap");
  assert.equal(id(pick(base({ log, context: { module: "planner" }, settings: { gapMinutes: 5 } }))), "planner/remind");
  assert.equal(id(pick(base({ log, surface: "cli", context: { module: "planner" } }))), "planner/remind");
});

test("tips: two minutes apart across every surface", () => {
  assert.equal(pick(base({ log: [{ surface: "cli", at: T - MIN }], context: { module: "planner" } })).why, "spread");
});

test("tips: six a day across every surface, counted over the last 24 hours", () => {
  const log = Array.from({ length: 6 }, (_, i) => ({ surface: i % 2 ? "cli" : "capsule", at: T - (i + 1) * HOUR }));
  assert.equal(pick(base({ log, context: { module: "planner" } })).why, "cap");
  log[5].at = T - 25 * HOUR;
  assert.equal(pick(base({ log, context: { module: "planner" } })).why, "current");
});

test("tips: a tip retires after two showings, and a dismissed one never returns", () => {
  const twice = new Map([["planner/remind", { shows: 2, last: T - 2 * HOUR, dismissed: false }]]);
  assert.equal(pick(base({ shown: twice, context: { module: "planner" } })).why, "none");
  const gone = new Map([["recall/try", { shows: 0, last: 0, dismissed: true }]]);
  assert.equal(id(pick(base({ shown: gone, context: { idle: true } }))), "vault/try");
});

test("tips: the same state always picks the same tip", () => {
  const s = base({ context: { idle: true } });
  assert.deepEqual(pick(s), pick(s));
});

test("tips: a surface's first open may show one discovery tip without idle, once", () => {
  const r = pick(base({ context: { first: true } }));
  assert.equal(id(r), "recall/try");
  assert.equal(r.why, "welcome");
  assert.equal(pick(base({ context: { first: true }, welcomed: true })).why, "none");
  assert.equal(pick(base({ context: { first: true, busy: true } })).why, "busy");
});
