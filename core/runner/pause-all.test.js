// @ts-check
// Review row 11: Pause all freezes a session with a stop signal; Windows has none (the signal ends the process), so there it must say so instead of answering "paused".
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerPlaceTools, SETTING_DEFAULTS } from "./place-tools.js";

/** @param {string} platform @param {Map<string, any>} runners */
function tools(platform, runners = new Map()) {
  /** @type {Map<string, any>} */ const t = new Map();
  registerPlaceTools({ tool: (/** @type {string} */ n, /** @type {any} */ def) => t.set(n, def), call: async () => ({}), kernel: {} }, { person: async () => "per_x", hostOf: () => null, runners, readSettings: async () => SETTING_DEFAULTS, titles: new Map(), platform });
  return (/** @type {string} */ name) => t.get(name).run({}, { caller: "cli" });
}

test("Pause all says it cannot on Windows, in plain words, and touches nothing", async () => {
  let paused = 0;
  const run = tools("win32", new Map([["spc_a", { info: () => [{ session: "s" }], pause: () => { paused++; }, resume: () => {} }]]));
  await assert.rejects(run("runner.pause-all"), (/** @type {any} */ e) => e.code === "unavailable" && /not available on Windows/.test(e.message));
  assert.equal(paused, 0, "no session was signalled");
  assert.deepEqual(await run("runner.resume-all"), { resumed: 1 }, "resume is harmless");
});

test("Pause all freezes the sessions on a Mac and on Linux", async () => {
  for (const platform of ["darwin", "linux"]) {
    let paused = 0;
    const run = tools(platform, new Map([["spc_a", { info: () => [{ session: "s" }], pause: () => { paused++; }, resume: () => {} }]]));
    assert.deepEqual(await run("runner.pause-all"), { paused: 1 });
    assert.equal(paused, 1);
  }
});
