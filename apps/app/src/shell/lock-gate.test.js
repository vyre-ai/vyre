import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCK_MINUTES, LOCK_CHOICES, UNREACHABLE, applyCover, createIdleLock, lockMinutes, lockView, lockWanted, statusFailure, unlockInput, unlockRefusal } from "./lock-gate.js";

/** A clock and a timer a test moves by hand. */
function clock() {
  let t = 1_000_000;
  /** @type {{ at: number, f: () => void, id: number }[]} */ let timers = [];
  let next = 1;
  return {
    now: () => t,
    setTimer: (/** @type {() => void} */ f, /** @type {number} */ ms) => { const id = next++; timers.push({ at: t + ms, f, id }); return id; },
    clearTimer: (/** @type {number} */ id) => { timers = timers.filter((x) => x.id !== id); },
    advance(/** @type {number} */ ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.f();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

test("an identity that is made and locked asks for the master password; a legacy one asks for a new one", () => {
  assert.equal(lockView({ exists: true, unlocked: false }), "unlock");
  assert.equal(lockView({ exists: true, unlocked: true }), "none");
  assert.equal(lockView({ exists: false, unlocked: false, needsMigration: true }), "migrate");
  assert.equal(lockView({ exists: false, unlocked: false }), "none", "no identity yet is the first run's business, not the lock's");
  assert.equal(lockView(null), "none");
  assert.equal(lockView(undefined), "none");
});

test("the auto-lock setting is one of the choices, and the default for anything else", () => {
  assert.equal(DEFAULT_LOCK_MINUTES, 15);
  for (const [v] of LOCK_CHOICES) assert.equal(lockMinutes(v), Number(v));
  for (const bad of [null, undefined, "", "7", "-1", "abc", "1e3"]) assert.equal(lockMinutes(bad), DEFAULT_LOCK_MINUTES);
});

test("the timer is wanted only for an unlocked identity with a setting that is not Never", () => {
  assert.equal(lockWanted({ exists: true, unlocked: true }, 15), true);
  assert.equal(lockWanted({ exists: true, unlocked: true }, 0), false);
  assert.equal(lockWanted({ exists: true, unlocked: false }, 15), false);
  assert.equal(lockWanted({ exists: false, unlocked: false }, 15), false);
  assert.equal(lockWanted(null, 15), false);
});

test("a password and a recovery key go in different fields, and a recovery key is trimmed", () => {
  assert.deepEqual(unlockInput({ mode: "password", text: " keep spaces " }), { password: " keep spaces " });
  assert.deepEqual(unlockInput({ mode: "recovery", text: "  ABCD-EFGH  " }), { recovery: "ABCD-EFGH" });
});

test("a refusal gets plain words and a next step", () => {
  assert.match(unlockRefusal("bad_password"), /master password.*recovery key/);
  assert.match(unlockRefusal("bad_recovery"), /recovery key/);
  assert.match(unlockRefusal("offline"), /not answering/);
  assert.equal(unlockRefusal("weird", "Words from the tool."), "Words from the tool.");
  assert.match(unlockRefusal("weird"), /Try again/);
});

test("the idle lock fires after the quiet spell and not before", () => {
  const c = clock();
  let locked = 0;
  const lock = createIdleLock({ minutes: 15, onIdle: () => { locked++; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  lock.start();
  c.advance(14 * 60_000);
  assert.equal(locked, 0);
  c.advance(60_000);
  assert.equal(locked, 1);
  assert.equal(lock.running, false);
  assert.equal(c.pending(), 0);
});

test("activity pushes the lock back by a whole spell from the last touch", () => {
  const c = clock();
  let locked = 0;
  const lock = createIdleLock({ minutes: 10, onIdle: () => { locked++; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  lock.start();
  c.advance(9 * 60_000);
  lock.touch();
  c.advance(9 * 60_000);
  assert.equal(locked, 0, "nine quiet minutes after a touch is not ten");
  c.advance(60_000);
  assert.equal(locked, 1);
});

test("stop clears the timer, and a stopped lock never fires", () => {
  const c = clock();
  let locked = 0;
  const lock = createIdleLock({ minutes: 5, onIdle: () => { locked++; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  lock.start();
  lock.stop();
  assert.equal(c.pending(), 0);
  c.advance(60 * 60_000);
  assert.equal(locked, 0);
});

test("Never (0 minutes) starts nothing", () => {
  const c = clock();
  const lock = createIdleLock({ minutes: 0, onIdle: () => { throw new Error("must not lock"); }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  lock.start();
  assert.equal(lock.running, false);
  assert.equal(c.pending(), 0);
});

test("a shorter setting takes effect on a running lock, counted from the last touch", () => {
  const c = clock();
  let locked = 0;
  const lock = createIdleLock({ minutes: 60, onIdle: () => { locked++; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  lock.start();
  c.advance(4 * 60_000);
  lock.setMinutes(5);
  c.advance(30_000);
  assert.equal(locked, 0);
  c.advance(30_000);
  assert.equal(locked, 1);
});

test("a lock fails closed: not read yet is covered, a failed read is covered and says so, and only a build with no identity tool is uncovered", () => {
  assert.equal(lockView(undefined, false), "pending", "before the first read the app is covered, blank");
  assert.equal(lockView({ exists: true, unlocked: true }, false), "pending");
  assert.equal(lockView({ unreachable: true }), "unreachable");
  assert.equal(lockView({ unreachable: true, exists: true, unlocked: true }), "unreachable", "an unreachable read wins over anything else it carries");
  assert.equal(lockView(null), "none", "a build with no identity tool has nothing to lock");
  assert.equal(UNREACHABLE.title, "Can't reach your vault");
  assert.equal(UNREACHABLE.lead, "Try again.");
});

test("a failed status read is unreachable unless the build has no identity tool at all", () => {
  for (const code of ["offline", "error", "denied", "relay_removed", "timeout", undefined]) assert.deepEqual(statusFailure({ code }), { unreachable: true }, String(code));
  assert.deepEqual(statusFailure(null), { unreachable: true });
  for (const code of ["no_such_tool", "not_found", "undeclared"]) assert.equal(statusFailure({ code }), null, code);
});

test("covering the app makes everything under it inert and hidden, and uncovering restores it", () => {
  const attrs = new Map();
  const el = { setAttribute: (n, v) => attrs.set(n, v), removeAttribute: (n) => attrs.delete(n) };
  applyCover(el, true);
  assert.equal(attrs.has("inert"), true, "inert takes the subtree out of the keyboard's reach");
  assert.equal(attrs.get("aria-hidden"), "true");
  applyCover(el, false);
  assert.equal(attrs.size, 0);
  applyCover(null, true);
});
