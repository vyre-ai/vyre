// MA-5: the kernel-off label branch (SHIM(legacy labels) in core/memory/index.js, site.js, write.js and the label fallbacks beside them) is reachable only while the daemon runs
// with the kernel OFF. That is today's default (VYRE_KERNEL is not set), so every build can run it until work/kernel-default-on lands. THIS TEST FAILS the day a daemon with no
// option and no VYRE_KERNEL boots with the kernel on: then delete every SHIM(legacy labels) branch (grep for it) and this file. Runs a real daemon: a test box, never a Mac.
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("the daemon still boots kernel-off by default, so the label branches in core/memory are still needed", async t => {
  const prev = process.env.VYRE_KERNEL;
  delete process.env.VYRE_KERNEL;
  t.after(() => { if (prev !== undefined) process.env.VYRE_KERNEL = prev; });
  const d = await start({ root: tempHome(t), log: () => {} });
  t.after(() => d.stop());
  assert.ok(!d.kernel, "the kernel is now ON by default: delete every `SHIM(legacy labels)` branch in core/memory (index.js viaTailnet and friends, site.js isPerson, write.js claims and the device rule, the OWNERS and OWNER label sets) and this test, and update team/0.3/CUTOVER.md section H.");
});
