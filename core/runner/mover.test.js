// @ts-check
// The mover: which sessions to hand to the server and why, from the person's limits and this computer's conditions.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMover, sleepReason, SUSTAIN_MS } from "./mover.js";

const ON = { enabled: true, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 };
const S = (/** @type {string} */ session, cpuPercent = 5, memoryMb = 300) => ({ session, cpuPercent, memoryMb });
const clock = () => { let t = 0; return { now: () => t, tick: (/** @type {number} */ ms) => { t += ms; } }; };

test("a condition that holds for the whole computer moves every session once, with its reason; nothing to move says nothing", () => {
  const m = createMover();
  const two = [S("a"), S("b")];
  assert.deepEqual(m.tick({ settings: { ...ON, enabled: false }, onPower: true, sessions: two }), [{ session: "a", reason: "switched-off" }, { session: "b", reason: "switched-off" }]);
  assert.deepEqual(m.tick({ settings: ON, sleeping: "lid-closed", onPower: true, sessions: two }).map(x => x.reason), ["lid-closed", "lid-closed"]);
  assert.deepEqual(m.tick({ settings: ON, sleeping: "asleep", onPower: false, sessions: [S("a")] }), [{ session: "a", reason: "asleep" }], "asleep before battery: the sleep is what the chat says");
  assert.deepEqual(m.tick({ settings: ON, onPower: false, sessions: two }).map(x => x.reason), ["unplugged", "unplugged"]);
  assert.deepEqual(m.tick({ settings: { ...ON, pluggedInOnly: false }, onPower: false, sessions: two }), [], "on battery is fine when the person allows it");
  assert.deepEqual(m.tick({ settings: { ...ON, enabled: false }, onPower: true, sessions: [] }), []);
});

test("a processor or memory limit passed for a sustained minute moves the heaviest session; a spike, or a minute that was broken, moves nothing", () => {
  const c = clock(), m = createMover({ now: c.now });
  const load = (/** @type {number} */ a, /** @type {number} */ b) => [S("light", 5, 200), S("heavy", a, 300), S("other", b, 300)];
  assert.deepEqual(m.tick({ settings: ON, onPower: true, sessions: load(40, 20) }), [], "60% over a 50% limit: the clock starts");
  c.tick(SUSTAIN_MS - 1);
  assert.deepEqual(m.tick({ settings: ON, onPower: true, sessions: load(40, 20) }), [], "not yet a minute");
  c.tick(1);
  assert.deepEqual(m.tick({ settings: ON, onPower: true, sessions: load(40, 20) }), [{ session: "heavy", reason: "cpu-cap" }], "a minute: the heaviest goes");
  assert.deepEqual(m.tick({ settings: ON, onPower: true, sessions: [S("light", 5, 200), S("other", 40, 300)] }), [], "the minute starts again for the next one");
  // a break resets the clock
  m.reset(); c.tick(1000);
  m.tick({ settings: ON, onPower: true, sessions: load(40, 20) }); c.tick(SUSTAIN_MS - 1000);
  m.tick({ settings: ON, onPower: true, sessions: load(1, 1) }); c.tick(2000);
  assert.deepEqual(m.tick({ settings: ON, onPower: true, sessions: load(40, 20) }), [], "under the limit in between: a new minute");
  // memory
  const mm = createMover({ now: c.now });
  const big = [S("a", 1, 3000), S("b", 1, 2000)];
  mm.tick({ settings: ON, onPower: true, sessions: big }); c.tick(SUSTAIN_MS);
  assert.deepEqual(mm.tick({ settings: ON, onPower: true, sessions: big }), [{ session: "a", reason: "mem-cap" }]);
});

test("a Mac says whether the lid is shut from its clamshell state; anything it cannot read, and any other system, is plain sleep", () => {
  assert.equal(sleepReason({ platform: "darwin", run: () => '    | |   "AppleClamshellState" = Yes\n' }), "lid-closed");
  assert.equal(sleepReason({ platform: "darwin", run: () => '    | |   "AppleClamshellState" = No\n' }), "asleep");
  assert.equal(sleepReason({ platform: "darwin", run: () => { throw new Error("no ioreg"); } }), "asleep");
  assert.equal(sleepReason({ platform: "linux", run: () => '"AppleClamshellState" = Yes' }), "asleep");
});
