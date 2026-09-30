// @ts-check
// stream.js's own unit tests, over a fake transport (no real vyred, no real network): the fast
// reachability probe added for native-bar budget 8 (a wait scheduled before the box comes back
// has no way to know it came back), and its cap so a genuinely long outage falls back to backoff
// alone rather than polling forever. The fault-proxy, real-vyred version of reconnect timing is
// test/chaos/chaos.test.js; this file is the fast, synthetic one for stream.js's own logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { follow } from "./stream.js";
import { backoff } from "./backoff.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function* none() {}

/**
 * A fake transport: the event stream opens once `up()` says so; a `/v1/health` probe answers 200
 * once `up()` says so too, and counts how many times it was asked.
 * @param {() => boolean} up
 */
function fakeTransport(up) {
  const healthAsks = [];
  const open = async ({ path, signal }) => {
    if (signal?.aborted) throw new Error("aborted");
    if (path.startsWith("/v1/health")) { healthAsks.push(Date.now()); if (!up()) throw new Error("down"); return { status: 200, chunks: none() }; }
    if (!up()) throw new Error("down");
    // A stream that stays open until aborted, like a real fetch does: waits on the signal rather
    // than hanging forever, so stop()/pause() in a test do not leave a stall timer running.
    return { status: 200, chunks: (async function* () { yield "retry: 2000\nid: 0\n\n"; await new Promise((_, j) => signal?.addEventListener("abort", () => j(new Error("aborted")))); })() };
  };
  return { open, healthAsks };
}

test("R1: a fast probe reconnects once the box answers, without waiting out a long backoff step", async () => {
  let up = false;
  const { open } = fakeTransport(() => up);
  const states = [];
  const s = follow({ paths: ["box"], open, onEvent: () => {}, onState: st => states.push(st.state),
    backoff: backoff({ min: 5_000, max: 5_000, jitter: 0 }), fastProbeMs: 20, fastProbeFor: 2_000 });
  await sleep(60);
  assert.ok(states.includes("reconnecting"), "went down");
  up = true;
  // Well under the 5 s backoff step: the fast probe (every 20 ms) should find it and reconnect.
  const opened = await Promise.race([
    (async () => { for (let i = 0; i < 40; i++) { if (states.at(-1) === "open") return true; await sleep(20); } return false; })(),
  ]);
  assert.ok(opened, `expected "open" within ~800 ms of the box answering, got states ${JSON.stringify(states)}`);
  s.stop();
});

test("R1: the fast probe stops after fastProbeFor, so a long outage does not poll forever", async () => {
  const { open, healthAsks } = fakeTransport(() => false);
  const s = follow({ paths: ["box"], open, onEvent: () => {}, onState: () => {},
    backoff: backoff({ min: 50, max: 50, jitter: 0 }), fastProbeMs: 15, fastProbeFor: 150 });
  await sleep(500);
  const count = healthAsks.length;
  await sleep(200);
  // No new probes once fastProbeFor has passed since the first failure: the count stops growing
  // (backoff keeps retrying the stream itself, at path "box", not "/v1/health").
  assert.equal(healthAsks.length, count, "the health probe kept running past its cap");
  assert.ok(count > 0 && count < 40, `expected a handful of probes while capped, got ${count}`);
  s.stop();
});

test("R1: pause() and stop() clear a pending fast probe (no dangling timer)", async () => {
  let up = false;
  const { open, healthAsks } = fakeTransport(() => up);
  const s = follow({ paths: ["box"], open, onEvent: () => {}, onState: () => {},
    backoff: backoff({ min: 5_000, max: 5_000, jitter: 0 }), fastProbeMs: 15, fastProbeFor: 2_000 });
  await sleep(60);
  s.pause();
  const atPause = healthAsks.length;
  await sleep(100);
  assert.equal(healthAsks.length, atPause, "pause() left the fast probe running");
  s.stop();
});
