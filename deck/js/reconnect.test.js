// @ts-check
// The Reconnecting pill's timing (js/reconnect.js, ADR 0029 R3), on node:test's fake timers:
// nothing on a blip, "Reconnecting" after the first failed retry, "since" once at 60 s, gone
// when the stream is open again, and the offline words while the device has no network.

import test from "node:test";
import assert from "node:assert/strict";
import { reconnectPill, SINCE_AFTER } from "./reconnect.js";

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  /** @type {(string|null)[]} */ const seen = [];
  let online = true;
  const pill = reconnectPill({ show: s => seen.push(s), hide: () => seen.push(null), online: () => online, now: () => Date.now(), fmt: at => `h${at}` });
  const at = (/** @type {number} */ ms) => t.mock.timers.tick(ms);
  return { pill, seen, at, offline: (/** @type {boolean} */ v) => { online = !v; } };
}

test("pill: a blip that heals on the first try shows nothing", t => {
  const { pill, seen, at } = setup(t);
  pill.state({ state: "open", attempt: 0, since: null });
  pill.state({ state: "reconnecting", attempt: 1, since: Date.now() });
  at(2_000);
  pill.state({ state: "reconnecting", attempt: 1, since: Date.now() - 2_000 }); // the retry itself
  pill.state({ state: "open", attempt: 0, since: null });
  at(120_000);
  assert.deepEqual(seen, []);
});

test("pill: shown after the first failed retry, says since when at 60 s, once, and goes when open", t => {
  const { pill, seen, at } = setup(t);
  const down = Date.now();
  pill.state({ state: "reconnecting", attempt: 1, since: down });
  at(2_000);
  pill.state({ state: "reconnecting", attempt: 2, since: down });
  assert.deepEqual(seen, ["Reconnecting"]);
  assert.equal(pill.shown, true);
  at(SINCE_AFTER - 2_001);
  assert.deepEqual(seen, ["Reconnecting"], "not before 60 s from the box's last answer");
  at(1);
  assert.deepEqual(seen, ["Reconnecting", `Reconnecting since h${down}`], "once, by the one timer");
  at(600_000);
  assert.equal(seen.length, 2, "no interval");
  pill.state({ state: "open", attempt: 0, since: null });
  assert.deepEqual(seen.at(-1), null);
  assert.equal(pill.shown, false);
});

test("pill: hidden before 60 s, its timer goes with it; a new outage starts over", t => {
  const { pill, seen, at } = setup(t);
  pill.state({ state: "reconnecting", attempt: 2, since: Date.now() });
  at(10_000);
  pill.state({ state: "open", attempt: 0, since: null });
  at(120_000);
  assert.deepEqual(seen, ["Reconnecting", null]);
  const again = Date.now();
  pill.state({ state: "reconnecting", attempt: 2, since: again });
  at(SINCE_AFTER);
  assert.deepEqual(seen.slice(2), ["Reconnecting", `Reconnecting since h${again}`]);
});

test("pill: offline keeps the offline words, and says Reconnecting again when the network is back", t => {
  const { pill, seen, offline } = setup(t);
  pill.net();
  assert.deepEqual(seen, [], "not shown: nothing to say yet");
  offline(true);
  pill.state({ state: "reconnecting", attempt: 2, since: Date.now() });
  assert.deepEqual(seen, ["This phone is offline."]);
  offline(false);
  pill.net();
  assert.deepEqual(seen, ["This phone is offline.", "Reconnecting"]);
});
