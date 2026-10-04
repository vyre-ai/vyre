// @ts-check
// Copy on the device tapped (clip-model.ts): the plan by platform, the note (a countdown only
// where clearing really happens), and the clear after 30 s only while the clipboard is still
// ours. Time and the clipboard are fakes. Loaded through Node's type stripping, so skipped on a
// Node without it. The module imports nothing, so this runs from the repo root as well.
import "../../scripts/test-guard.mjs";

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./clip-model.ts");

/** A fake clipboard and fake timers. @param {string} os @param {boolean} silent */
function world(os, silent) {
  /** @type {Map<number, () => void>} */
  const timers = new Map();
  let seq = 0;
  const b = {
    held: /** @type {string | null} */ (null),
    reads: 0,
    clears: 0,
    os,
    /** @param {Promise<string | null>} p */
    async write(p) {
      const v = await p;
      if (v === null) return false;
      b.held = v;
      return true;
    },
    async readsSilently() {
      return silent;
    },
    async read() {
      b.reads++;
      return b.held;
    },
    async clear() {
      b.clears++;
      b.held = "";
    },
  };
  const t = {
    /** @param {() => void} f @param {number} ms */
    set: (f, ms) => {
      assert.equal(ms, 30_000);
      const id = ++seq;
      timers.set(id, f);
      return id;
    },
    /** @param {unknown} id */
    clear: id => void timers.delete(/** @type {number} */ (id)),
  };
  const fire = async () => {
    const fs = [...timers.values()];
    timers.clear();
    for (const f of fs) f();
    await new Promise(r => setImmediate(r));
  };
  return { b, t, timers, fire };
}

test("plan: native never reads; a browser compares only when it reads without a prompt", { skip: !strip }, async () => {
  const { planFor } = await load();
  assert.equal(planFor("ios", false), "if-last");
  assert.equal(planFor("android", true), "if-last", "native never reads, even where it could");
  assert.equal(planFor("web", true), "compare");
  assert.equal(planFor("web", false), "none");
});

test("note: the countdown only where clearing will happen", { skip: !strip }, async () => {
  const { copiedNote } = await load();
  assert.equal(copiedNote("if-last"), "Copied · clears in 30 s");
  assert.equal(copiedNote("compare"), "Copied · clears in 30 s");
  assert.equal(copiedNote("none"), "Copied");
});

test("shouldClear: only our own copy, and on compare only the same value", { skip: !strip }, async () => {
  const { shouldClear } = await load();
  assert.equal(shouldClear("if-last", { mine: true }), true);
  assert.equal(shouldClear("if-last", { mine: false }), false);
  assert.equal(shouldClear("compare", { mine: true, current: "s3cret", value: "s3cret" }), true);
  assert.equal(shouldClear("compare", { mine: true, current: "something else", value: "s3cret" }), false);
  assert.equal(shouldClear("compare", { mine: true, current: null, value: "s3cret" }), false, "an unreadable clipboard is left alone");
  assert.equal(shouldClear("none", { mine: true, current: "s3cret", value: "s3cret" }), false);
});

test("native: copied, then cleared after 30 s without ever reading", { skip: !strip }, async () => {
  const { makeClip } = await load();
  const w = world("ios", false);
  const clip = makeClip(w.b, w.t);
  assert.deepEqual(await clip.copy(Promise.resolve("s3cret")), { said: "Copied · clears in 30 s" });
  assert.equal(w.b.held, "s3cret");
  await w.fire();
  assert.equal(w.b.clears, 1);
  assert.equal(w.b.held, "");
  assert.equal(w.b.reads, 0);
});

test("native: a later copy by the app takes over; only its timer clears", { skip: !strip }, async () => {
  const { makeClip } = await load();
  const w = world("android", false);
  const clip = makeClip(w.b, w.t);
  await clip.copy(Promise.resolve("first"));
  await clip.copy(Promise.resolve("second"));
  assert.equal(w.timers.size, 1, "the first timer is dropped");
  await w.fire();
  assert.equal(w.b.clears, 1);
});

test("web with silent read: cleared only while it still holds the value", { skip: !strip }, async () => {
  const { makeClip } = await load();
  const w = world("web", true);
  const clip = makeClip(w.b, w.t);
  await clip.copy(Promise.resolve("s3cret"));
  await w.fire();
  assert.equal(w.b.clears, 1);

  await clip.copy(Promise.resolve("s3cret"));
  w.b.held = "the person copied this elsewhere";
  await w.fire();
  assert.equal(w.b.reads, 2);
  assert.equal(w.b.clears, 1, "left alone");
  assert.equal(w.b.held, "the person copied this elsewhere");
});

test("web without silent read: 'Copied', no countdown, never cleared", { skip: !strip }, async () => {
  const { makeClip } = await load();
  const w = world("web", false);
  const clip = makeClip(w.b, w.t);
  assert.deepEqual(await clip.copy(Promise.resolve("s3cret")), { said: "Copied" });
  assert.equal(w.timers.size, 0);
  assert.equal(w.b.clears, 0);
});

test("no value (refused or offline): nothing copied, nothing scheduled", { skip: !strip }, async () => {
  const { makeClip } = await load();
  const w = world("ios", false);
  const clip = makeClip(w.b, w.t);
  assert.equal(await clip.copy(Promise.resolve(null)), null);
  assert.equal(w.timers.size, 0);
  assert.equal(w.b.held, null);
});
