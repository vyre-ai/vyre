// @ts-check
// A workspace that could not be closed is chased in the background. If the lease is taken again before the chase has closed it, the chase must stop: it must not unmount the workspace the lender has just got back.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRunner } from "./runner.js";
import { fakeSpace } from "./testing/fake-space.js";
import { tmp, rm } from "./testing/runner-test-lib.js";

test("a chase that is still waiting when the lease is taken again does not unmount the workspace", async t => {
  const base = tmp(), mount = tmp();
  t.after(() => { rm(base); rm(mount); });
  const sp = fakeSpace({ ttlMs: 3_600_000 });
  let mounted = false, failUnmount = true, unmounts = 0;
  const driver = { name: "fake", exists: () => true, create: async () => {}, mount: async () => { mounted = true; return mount; },
    unmount: async () => { unmounts++; if (failUnmount) throw new Error("busy"); mounted = false; }, isMounted: () => mounted, destroy: async () => { mounted = false; } };
  /** @type {(() => Promise<void>)[]} */ const steps = [];
  const r = createRunner({ base, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), requestServer: () => {}, retryMs: 5, lockRetryMs: 1, driver,
    // only the close chase's timers (2 s, then 5 s) are held back for the test to fire late; the lease's own renew and expiry timers (also routed through setTimer) are real ones, left alone
    setTimer: (/** @type {() => Promise<void>} */ f, /** @type {number} */ ms) => {
      if (ms === 2000 || ms === 5000) { steps.push(f); return /** @type {any} */ ({ unref() {} }); }
      const t = setTimeout(f, ms); t.unref?.(); return t;
    } });
  t.after(async () => { failUnmount = false; try { await r.lock(); } catch { /* closed */ } });
  assert.equal((await r.contact()).ok, true);
  assert.equal(mounted, true);
  await r.lock();   // the workspace is busy: it cannot be closed now, so a chase is left waiting
  assert.equal(steps.length >= 1, true, "a chase is waiting");
  failUnmount = false;
  assert.equal((await r.contact()).ok, true, "the lender gets its lease back");
  const before = unmounts;
  for (const f of steps) await f();   // the chase's timer fires late
  assert.equal(unmounts, before, "the chase did not try to close it again");
  assert.equal(mounted, true, "the workspace the lender has back is still open");
  assert.equal(fs.existsSync(mount), true);
});
