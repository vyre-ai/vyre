// @ts-check
// stopDaemonBounded (test/helpers.js) ends only the children that appeared after it was called, says so by pid, and leaves the file's own earlier children and the ones it keeps alone.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopDaemonBounded } from "./helpers.js";

const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (/** @type {() => boolean} */ fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); };
/** A stand-in for the test context: the helper registers one function to run at the end. */
const fakeT = () => { /** @type {any} */ const t = { run: null, after(/** @type {any} */ fn) { t.run = fn; } }; return t; };

test("a child that appeared after the call is ended and reported; an earlier one and a kept one are left alone", async () => {
  const early = spawn("sleep", ["30"], { stdio: "ignore" });
  const t = fakeT();
  stopDaemonBounded(t, { stop: async () => {} }, { keep: pid => pid === kept.pid });
  const left = spawn("sleep", ["30"], { stdio: "ignore" }), kept = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await assert.rejects(t.run(), err => /left 1 child process/.test(err.message) && err.message.includes(String(left.pid)));
    await until(() => !alive(/** @type {number} */ (left.pid)));
    assert.equal(alive(/** @type {number} */ (left.pid)), false, "the child left behind is ended");
    assert.equal(alive(/** @type {number} */ (early.pid)), true, "a child that was there before is not the daemon's");
    assert.equal(alive(/** @type {number} */ (kept.pid)), true, "a child the file keeps is left alone");
  } finally { early.kill("SIGKILL"); kept.kill("SIGKILL"); left.kill("SIGKILL"); }
});

test("a daemon that stops cleanly with no new child passes, and a stop that throws fails the test", async () => {
  const t = fakeT();
  stopDaemonBounded(t, { stop: async () => {} });
  await t.run();
  const t2 = fakeT();
  stopDaemonBounded(t2, { stop: async () => { throw new Error("would not stop"); } });
  await assert.rejects(t2.run(), /would not stop/);
});
