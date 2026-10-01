// @ts-check
// runner.js's stop(): must never hang the caller forever. Seen as a real, non-deterministic hang
// on GitHub's Node 24 runners (3 of 4 recent CI runs, never reproduced on testbox): the last test
// in a file passes, then the process never exits. registry.stop() already bounds each module with
// MODULE_STOP_MS (settings.test.js hang, fcce3d4a) - the gap underneath that race was this file's
// own stop(), an unbounded await on the child's "exit" event with no fallback if the OS process
// never actually goes (killGroup's -pid missing the group `detached` was meant to make, a lost
// signal, a zombie GH's containers never reap - the exact cause was not pinned down). The fix does
// not depend on which of those it was: past grace + one more beat, stop waiting and destroy our
// own pipes to the child, so vyred's event loop lets go of it regardless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./runner.js";

/** run() against a plain shell command instead of a real claude, with onMessage/onExit captured. */
function start(bin, args, o = {}) {
  const events = [];
  const proc = run({ bin, args, cwd: process.cwd(), env: process.env, onMessage: m => events.push(m), onExit: (code, signal) => events.push({ exit: { code, signal } }), ...o });
  return { proc, events };
}

test("runner: stop() resolves once the child exits on its own (stdin close, no signal needed)", async () => {
  // cat echoes stdin back until it closes, then exits 0 on its own - the common case.
  const { proc } = start("cat", []);
  const t0 = Date.now();
  await proc.stop(3000);
  assert.ok(Date.now() - t0 < 2000, "a cooperative child should not need TERM or KILL to stop");
});

test("runner: stop() escalates to SIGKILL and still resolves when the child ignores SIGTERM", async () => {
  // Ignores TERM, keeps stdin open (so closing it alone does not end it); only KILL ends it.
  const { proc } = start("sh", ["-c", "trap '' TERM; while true; do sleep 0.1; done"]);
  const t0 = Date.now();
  await proc.stop(300);
  const took = Date.now() - t0;
  // SIGTERM at min(500, grace)=300ms is ignored; SIGKILL at grace=300ms cannot be. Resolves via
  // the real exit, well under the 2000ms fallback this same call would give up at.
  assert.ok(took < 2000, `stop() should resolve on the real SIGKILL, not the fallback: took ${took}ms`);
});

test("runner: stop() never waits past grace plus the fallback beat, whatever the child does", async () => {
  // Same stubborn child as above, but with a grace so small the escalation timers and the
  // giveUp timer are close together - proves the promise always settles by grace + 2000ms even
  // under timing pressure, not just in the common case above.
  const { proc } = start("sh", ["-c", "trap '' TERM; while true; do sleep 0.1; done"]);
  const t0 = Date.now();
  await proc.stop(50);
  assert.ok(Date.now() - t0 <= 2100, "stop(50) must settle at or before grace (50ms) + the 2000ms fallback beat");
});
