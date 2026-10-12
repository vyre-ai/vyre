import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startEventPoll } from "./event-poll.js";

const tick = () => new Promise((r) => setTimeout(r, 4));
const log = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, type: "task.updated", subject: `vyre://spc/task/${i}` }));

test("the first look fires nothing; a later event fires once; the cursor goes in `since`", async () => {
  let events = log(3); const asked = []; const got = [];
  const stop = startEventPoll({ spaceNow: async () => "spc_aaaaaaaaaaaa", ask: async (_s, i) => { asked.push(i); return { events: events.filter((e) => i.since === undefined || e.seq > i.since) }; }, onEvent: (e) => got.push(e.seq), sleep: tick });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(got, [], "history is not news");
  events = log(5);
  for (let i = 0; i < 8; i++) await tick();
  stop();
  assert.deepEqual(got, [4, 5], "each new event once");
  assert.deepEqual(asked[0], { limit: 200 });
  assert.ok(asked.slice(1).every((a) => a.since >= 3));
});

test("a hidden app asks nothing; with no joined team showing it asks nothing; stopping stops it", async () => {
  let shown = false, space = null, n = 0;
  const stop = startEventPoll({ spaceNow: async () => space, ask: async () => { n++; return { events: [] }; }, onEvent() {}, visible: () => shown, sleep: tick });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(n, 0, "hidden and no team");
  shown = true; for (let i = 0; i < 6; i++) await tick();
  assert.equal(n, 0, "visible but no joined team showing");
  space = "spc_aaaaaaaaaaaa"; for (let i = 0; i < 6; i++) await tick();
  assert.ok(n > 0, "visible and a team showing");
  stop(); const at = n; for (let i = 0; i < 6; i++) await tick();
  assert.ok(n <= at + 1, "stopped");
});

test("the cursor is the poller's own: a failing look (the session was dropped) does not lose it, and nothing is fired twice after recovery", async () => {
  let events = log(2), fail = false; const got = [];
  const stop = startEventPoll({ spaceNow: async () => "spc_aaaaaaaaaaaa", ask: async (_s, i) => { if (fail) throw Object.assign(new Error("gone"), { code: "unreachable" }); return { events: events.filter((e) => i.since === undefined || e.seq > i.since) }; }, onEvent: (e) => got.push(e.seq), sleep: tick });
  for (let i = 0; i < 5; i++) await tick();
  fail = true; events = log(4); for (let i = 0; i < 5; i++) await tick();
  fail = false; for (let i = 0; i < 8; i++) await tick();
  stop();
  assert.deepEqual(got, [3, 4]);
});

test("events without a number are told apart by their id: only the ones after the last seen fire", async () => {
  let events = [{ id: "a", type: "x" }, { id: "b", type: "x" }]; const got = [];
  const stop = startEventPoll({ spaceNow: async () => "spc_aaaaaaaaaaaa", ask: async () => ({ events }), onEvent: (e) => got.push(e.id), sleep: tick });
  for (let i = 0; i < 5; i++) await tick();
  events = [...events, { id: "c", type: "x" }]; for (let i = 0; i < 6; i++) await tick();
  stop();
  assert.deepEqual(got, ["c"]);
});
