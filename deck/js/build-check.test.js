// @ts-check
// deck/js/build-check.js: a page older than its box updates itself, invisibly; a dev world never loops.

import test from "node:test";
import assert from "node:assert/strict";
import { buildIdOf, stale, checkBuild } from "./build-check.js";
import { buildId } from "../../core/daemon/build.js";

test("the page and the box compute the same id (core/daemon/build.js buildId)", () => {
  for (const b of [{ version: "0.2.0", commit: "1a2b3c4d5e6f7a8b", dirty: false }, { version: "0.2.0", commit: "1a2b3c4d5e6f7a8b", dirty: true },
    { version: "0.2.0", commit: null, dirty: null }]) {
    assert.equal(buildIdOf(b), buildId(/** @type {any} */ ({ ...b, stamped: true })));
  }
});

test("stale only on a real mismatch: never for dev, never when the box doesn't say", () => {
  const info = { version: "0.2.0", commit: "abcdefabcdef0000" };
  assert.equal(stale("abcdefabcdef", info), false);
  assert.equal(stale("111111111111", info), true);
  assert.equal(stale("dev", info), false);
  assert.equal(stale("111111111111", {}), false);
  assert.equal(stale(null, info), false);
});

test("a mismatch asks the service worker; without one it reloads now if untouched, else when hidden", () => {
  const info = { version: "0.2.0", commit: "abcdefabcdef0000" };
  let updates = 0, reloads = 0, later = null;
  const base = { page: "111111111111", info, reload: () => { reloads++; }, onHidden: (/** @type {any} */ fn) => { later = fn; } };
  assert.equal(checkBuild({ ...base, sw: { update: async () => { updates++; } }, untouched: () => true }), "sw");
  assert.equal(updates, 1);
  assert.equal(reloads, 0, "the new worker's takeover does the reload (app.js controllerchange)");
  assert.equal(checkBuild({ ...base, sw: null, untouched: () => true }), "reload");
  assert.equal(reloads, 1);
  assert.equal(checkBuild({ ...base, sw: null, untouched: () => false }), "later");
  assert.equal(reloads, 1, "never under someone's finger");
  /** @type {any} */ (later)();
  assert.equal(reloads, 2);
  assert.equal(checkBuild({ ...base, page: "abcdefabcdef", sw: null, untouched: () => true }), "fresh");
});
