// @ts-check
// `vyre reboot`: a planned restart goes through FileVault's authrestart on a Mac server that has it on, and never happens unasked.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebootPlan, reboot } from "./reboot.js";

/** @param {string} fv @param {boolean} sup */
const mk = (fv, sup) => (/** @type {string} */ _cmd, /** @type {string[]} */ args) => (args[0] === "status" ? `FileVault is ${fv}.` : args[0] === "supportsauthrestart" ? String(sup) : "");

test("the plan: authrestart only with FileVault on and support; the reason says what the person will see", () => {
  const a = rebootPlan(mk("On", true));
  assert.deepEqual([a.how, a.cmd, a.args], ["authrestart", "/usr/bin/fdesetup", ["authrestart"]]);
  assert.match(a.why, /straight back to the desktop/);
  const b = rebootPlan(mk("On", false));
  assert.deepEqual([b.how, b.cmd, b.args], ["restart", "/sbin/shutdown", ["-r", "now"]]);
  assert.match(b.why, /waits at the login window/, "a FileVault Mac that cannot authrestart is told it will wait for the password");
  const c = rebootPlan(mk("Off", false));
  assert.equal(c.how, "restart");
  assert.match(c.why, /FileVault is off/);
});

test("it restarts only when told: --dry-run does nothing, a non-root run is refused, no terminal and no --yes is a usage error", async () => {
  /** @type {string[][]} */ const ran = [];
  const spawn = (/** @type {string} */ cmd, /** @type {string[]} */ a) => { ran.push([cmd, ...a]); return 0; };
  const base = { run: mk("On", true), spawn, tty: false };
  assert.equal(await reboot(["--dry-run"], { ...base, uid: 0 }), 0);
  assert.notEqual(await reboot(["--yes"], { ...base, uid: 501 }), 0, "not root: refused");
  assert.equal(await reboot([], { ...base, uid: 0 }), 2, "no terminal, no --yes: usage");
  assert.deepEqual(ran, [], "nothing ran so far");
});

test("--yes as root runs fdesetup authrestart on a FileVault Mac; a 'no' answer changes nothing; a failing command is reported", async () => {
  /** @type {string[][]} */ const ran = [];
  const spawn = (code) => (/** @type {string} */ cmd, /** @type {string[]} */ a) => { ran.push([cmd, ...a]); return code; };
  assert.equal(await reboot(["--yes"], { run: mk("On", true), spawn: spawn(0), tty: false, uid: 0 }), 0);
  assert.deepEqual(ran, [["/usr/bin/fdesetup", "authrestart"]]);
  ran.length = 0;
  assert.notEqual(await reboot([], { run: mk("On", true), spawn: spawn(0), tty: true, uid: 0, ask: async () => "n" }), 0);
  assert.deepEqual(ran, [], "answering no restarts nothing");
  assert.equal(await reboot([], { run: mk("Off", false), spawn: spawn(0), tty: true, uid: 0, ask: async () => "y" }), 0);
  assert.deepEqual(ran, [["/sbin/shutdown", "-r", "now"]]);
  assert.notEqual(await reboot(["--yes"], { run: mk("On", true), spawn: spawn(1), tty: false, uid: 0 }), 0, "a failed fdesetup is a failure, not a silent restart");
});
