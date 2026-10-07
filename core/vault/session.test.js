// @ts-check
// session tests: a fake clock and fake timers, so idle and lifetime limits are exact and nothing
// waits. The token must never appear in an event, and a session never covers a reprompt item.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sessions, duration, lockConfig, reprompt } from "./session.js";

function rig({ rows = {}, config, ...extra } = {}) {
  const clock = { t: 1_000_000 };
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let id = 0;
  const events = [];
  const vault = { row: n => rows[n], ...extra };
  const s = new Sessions({
    vault, config, now: () => clock.t, emit: (type, p) => events.push({ type, p }),
    timers: { set: (fn, ms) => { timers.set(++id, { fn, at: clock.t + ms }); return id; }, clear: t => { timers.delete(t); } },
  });
  /** Move the clock and fire whatever timers came due. */
  const advance = ms => {
    clock.t += ms;
    for (const [k, v] of [...timers]) if (v.at <= clock.t) { timers.delete(k); v.fn(); }
  };
  return { s, clock, timers, events, advance };
}

test("duration and lockConfig read the config's words", () => {
  assert.equal(duration("10m", 1), 600_000);
  assert.equal(duration("12h", 1), 43_200_000);
  assert.equal(duration("30s", 1), 30_000);
  assert.equal(duration(90, 1), 90_000);
  assert.equal(duration("soon", 7), 7);
  assert.deepEqual(lockConfig({}), { idle: 600_000, max: 43_200_000, onSleep: true, onScreenLock: true });
  assert.deepEqual(lockConfig({ vault: { lock: { idle: "5m", max: "1h", onSleep: false } } }), { idle: 300_000, max: 3_600_000, onSleep: false, onScreenLock: true });
});

test("a session opens, covers use, and closes; the token is 32 bytes and never in an event", () => {
  const { s, events } = rig({ rows: { "site-login": { kind: "login" } } });
  const o = s.open("deck");
  assert.equal(Buffer.from(o.session, "base64url").length, 32);
  assert.equal(o.surface, "deck");
  assert.equal(s.ok(o.session, "site-login"), true);
  assert.equal(s.ok(o.session), true);
  assert.equal(s.ok("not-a-token", "site-login"), false);
  assert.equal(s.ok(undefined), false);
  assert.deepEqual(s.status(o.session).unlocked, true);
  assert.equal(s.status(o.session).surface, "deck");
  assert.deepEqual(s.close(o.session), { closed: true });
  assert.deepEqual(s.close(o.session), { closed: false });
  assert.equal(s.ok(o.session), false);
  assert.deepEqual(events.map(e => e.type), ["vault.unlocked", "vault.locked"]);
  assert.ok(!JSON.stringify(events).includes(o.session));
  assert.throws(() => s.open("browser"), /deck, capsule, extension/);
});

test("the idle limit ends a session; use pushes it back; the lifetime caps it", () => {
  const { s, advance, clock } = rig({ config: { vault: { lock: { idle: "10m", max: "1h" } } } });
  const a = s.open("capsule");
  advance(9 * 60_000);
  assert.equal(s.ok(a.session), true, "used inside the idle limit");
  advance(9 * 60_000);
  assert.equal(s.ok(a.session), true, "the use pushed the idle limit back");
  advance(11 * 60_000);
  assert.equal(s.ok(a.session), false, "idle too long");

  const b = s.open("capsule");
  for (let i = 0; i < 6; i++) { advance(9 * 60_000); assert.equal(s.ok(b.session), true); }
  advance(9 * 60_000);
  assert.equal(s.ok(b.session), false, "an hour is the most, however busy");

  const c = s.open("extension", 120);
  assert.equal(c.expires, clock.t + 120_000, "ttl_s asks for less than the maximum");
  advance(121_000);
  assert.equal(s.ok(c.session), false);
});

test("each session has at most one timer, and it ends the session with no use at all", () => {
  const { s, timers, advance, events } = rig();
  const a = s.open("deck"), b = s.open("capsule");
  assert.equal(timers.size, 2);
  for (let i = 0; i < 20; i++) s.ok(a.session);
  assert.equal(timers.size, 2, "use does not add timers");
  advance(5 * 60_000);
  s.ok(a.session);
  advance(6 * 60_000);
  assert.equal(s.count(), 1, "the unused one ended on its timer; the used one was re-armed");
  assert.equal(timers.size, 1);
  advance(10 * 60_000);
  assert.equal(s.count(), 0);
  assert.equal(timers.size, 0);
  assert.equal(s.ok(b.session), false);
  assert.ok(events.filter(e => e.type === "vault.locked").every(e => e.p.why === "expired"));
});

test("a reprompt item is never covered; cards count as reprompt until the sealed meta says otherwise", () => {
  const rows = {
    login: { kind: "login" },
    card: { kind: "card" },
    "card-ok": { kind: "card", meta: JSON.stringify({ reprompt: false }) },
    flagged: { kind: "login", meta: { reprompt: true } },
  };
  const { s } = rig({ rows });
  const o = s.open("deck");
  assert.equal(s.ok(o.session, "login"), true);
  assert.equal(s.ok(o.session, "card"), false);
  assert.equal(s.ok(o.session, "card-ok"), true);
  assert.equal(s.ok(o.session, "flagged"), false);
  assert.equal(s.ok(o.session, "missing"), false);
  assert.equal(reprompt({ row: () => { throw new Error("x"); } }, "a"), true);
});

test("closing the last session drops the personal key; closeAll ends them together", () => {
  let locks = 0;
  const { s, events } = rig({ pvk: {}, lockAccount: () => { locks++; } });
  const a = s.open("deck"), b = s.open("capsule");
  s.close(a.session);
  assert.equal(locks, 0, "one is still open");
  s.close(b.session);
  assert.equal(locks, 1);
  s.open("deck"); s.open("extension");
  assert.equal(s.closeAll("screen-lock"), 2);
  assert.equal(locks, 2);
  assert.equal(s.closeAll("screen-lock"), 0, "nothing to end");
  assert.equal(locks, 2);
  const last = events.at(-1);
  assert.deepEqual(last, { type: "vault.locked", p: { surface: "all", why: "screen-lock", ended: 2, sessions: 0 } });
});
