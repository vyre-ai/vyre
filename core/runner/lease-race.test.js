// @ts-check
// Two races around the end of a lease. (1) A lease that ended and is taken again while the sessions are still being stopped must keep the workspace it just got back. (2) A lease whose vault answer arrives
// after access was revoked must not open: the key is dropped, the workspace is deleted, no key is held.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRunner } from "./runner.js";
import { fakeSpace } from "./testing/fake-space.js";
import { rig, waitFor, SKIP, tmp, rm } from "./testing/runner-test-lib.js";

test("a lease taken again while the sessions are still stopping keeps its workspace open", { skip: SKIP || false, timeout: 90_000 }, async t => {
  /** @type {() => void} */ let open = () => {};
  const gate = new Promise(r => { open = () => r(undefined); });
  const r = await rig(t, { requestServer: async () => { await gate; return { moved: false, why: "test" }; } });
  const h = await r.launch(r.runner, "s1");
  h.send("turn before release");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1, 60_000);
  const ending = r.runner.lease.release();   // the lock handler is now held at the hand-over to the server
  await waitFor(() => r.runner.lease.state === "locked", 10_000);
  const back = r.runner.contact();           // back in contact before the handler is done
  open();
  await ending;
  assert.equal((await back).ok, true);
  assert.equal(r.runner.lease.state, "open");
  assert.equal(r.runner.status().mounted, true, "the workspace the lender has back is still open");
  assert.ok(r.runner.lease.key(), "and the key is held");
});

test("a vault answer that arrives after a revoke opens nothing and keeps no key", async t => {
  const base = tmp(), mount = tmp();
  t.after(() => { rm(base); rm(mount); });
  const sp = fakeSpace({ ttlMs: 3_600_000 });
  /** @type {() => void} */ let release = () => {};
  const held = new Promise(res => { release = () => res(undefined); });
  const vault = { ...sp.vault, async lease(/** @type {any} */ a) { await held; return sp.vault.lease(a); } };
  let mounted = false, destroyed = 0;
  const driver = { name: "fake", exists: () => true, create: async () => {}, mount: async () => { mounted = true; return mount; },
    unmount: async () => { mounted = false; }, isMounted: () => mounted, destroy: async () => { destroyed++; mounted = false; fs.rmSync(base, { recursive: true, force: true }); } };
  const r = createRunner({ base, space: "harlow", device: "kit", vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), requestServer: () => {}, retryMs: 5, lockRetryMs: 1, driver, watchdog: false });
  const asking = r.contact();   // the vault has not answered yet
  await r.revoke();
  assert.equal(r.lease.state, "revoked");
  release();                    // the answer arrives, with a key
  const c = await asking;
  assert.equal(c.ok, false);
  assert.equal(r.lease.state, "revoked");
  assert.equal(r.lease.key(), null, "no key is held");
  assert.equal(mounted, false, "nothing is mounted");
  assert.ok(destroyed >= 1, "the workspace was deleted");
});
