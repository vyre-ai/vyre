// @ts-check
// The 0.6.0 limit, said plainly: when the fscrypt helper answers that removing the workspace key is "incomplete" (a process still holds a file open), one line says so. Nothing else changes.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sayIfIncomplete } from "./workspace.js";

test("an incomplete key removal is said in one plain line; a finished one, an empty answer and a failure say nothing", () => {
  /** @type {string[]} */ const said = [];
  assert.equal(sayIfIncomplete({ out: "incomplete\n" }, m => said.push(m)), true);
  assert.deepEqual(said, ["the key is removed but a process still holds a file open: it can read until it exits"]);
  said.length = 0;
  for (const r of [{ out: "removed\n" }, { out: "" }, {}, null, undefined]) assert.equal(sayIfIncomplete(/** @type {any} */ (r), m => said.push(m)), false);
  assert.deepEqual(said, []);
});

import { lockUntilComplete, holdersOf } from "./workspace.js";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";

/** @param {string[]} answers */
function fake(answers) {
  /** @type {Array<[number, string]>} */ const killed = []; let removes = 0;
  return { killed, removes: () => removes, d: { remove: async () => ({ out: answers[Math.min(removes++, answers.length - 1)] + "\n" }), holders: () => [7, 9], kill: (/** @type {number} */ p, /** @type {NodeJS.Signals} */ s) => { killed.push([p, s]); }, sleep: async () => {}, waitMs: 0 } };
}

test("a finished removal locks at once and stops nobody", async () => {
  const f = fake(["removed"]);
  assert.deepEqual(await lockUntilComplete(f.d), { locked: true, rounds: 1 });
  assert.deepEqual(f.killed, []);
});

test("an incomplete removal stops the holders (term, then kill) and removes again until it is finished", async () => {
  const f = fake(["incomplete", "incomplete", "incomplete", "removed"]);
  const said = /** @type {string[]} */ ([]);
  assert.deepEqual(await lockUntilComplete({ ...f.d, log: m => said.push(m) }), { locked: true, rounds: 4 });
  assert.deepEqual(f.killed.map(k => k[1]), ["SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM", "SIGKILL", "SIGKILL"]);
  assert.equal(said.length, 4, "three incomplete lines and the one count line");
});

test("a holder that never goes is never reported as locked: the answer is locked:false after the bounded tries", async () => {
  const f = fake(["incomplete"]);
  const r = await lockUntilComplete({ ...f.d, tries: 4 });
  assert.deepEqual(r, { locked: false, rounds: 4 });
  assert.equal(f.removes(), 4);
});

test("holdersOf finds a process whose working directory or open file is under the folder, and never this process", { skip: process.platform !== "linux" }, async t => {
  const { spawn } = await import("node:child_process");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tempHome(t), "held-")));
  fs.writeFileSync(path.join(base, "f"), "x");
  const cwdKid = spawn("sleep", ["30"], { cwd: base, stdio: "ignore" });
  const fdKid = spawn("sh", ["-c", "exec 3<f; sleep 30"], { cwd: "/", stdio: "ignore", env: { ...process.env } });
  const fileKid = spawn("sh", ["-c", `exec 3<${path.join(base, "f")}; sleep 30`], { stdio: "ignore" });
  t.after(() => { for (const k of [cwdKid, fdKid, fileKid]) k.kill("SIGKILL"); });
  await new Promise(r => setTimeout(r, 400));
  const found = holdersOf(base);
  assert.ok(found.includes(/** @type {number} */ (cwdKid.pid)), "cwd");
  assert.ok(found.includes(/** @type {number} */ (fileKid.pid)), "open file");
  assert.ok(!found.includes(/** @type {number} */ (fdKid.pid)), "a process elsewhere is not a holder");
  assert.ok(!found.includes(process.pid));
  assert.deepEqual(holdersOf(path.join(base, "nothing")), []);
});

const FSDIR = process.env.VYRE_FSCRYPT_DIR || "";
test("a real fscrypt workspace: a plain lock answers locked, and a process holding a file open is stopped so the lock still completes", { skip: process.platform !== "linux" || !FSDIR, timeout: 60_000 }, async t => {
  const { driverFor, fscryptSupported } = await import("./workspace.js");
  if (!fscryptSupported(FSDIR)) return t.skip("no fscrypt here");
  const { spawn } = await import("node:child_process");
  const { randomBytes } = await import("node:crypto");
  const base = fs.mkdtempSync(path.join(FSDIR, "lock-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const drv = driverFor("linux", { prefer: "fscrypt", log: () => {} });
  const dir = path.join(base, "w"), key = randomBytes(32);
  await drv.create(dir, key);
  const m = await drv.mount(dir, key);
  await drv.unmount(dir);
  assert.equal(drv.isMounted(dir), false, "nothing holds it: the first lock is complete");
  await drv.mount(dir, key);
  fs.writeFileSync(path.join(m, "f"), "x");
  const kid = spawn("sh", ["-c", `cd ${m}; exec 3<f; sleep 60`], { stdio: "ignore" });
  t.after(() => kid.kill("SIGKILL"));
  await new Promise(r => setTimeout(r, 400));
  const gone = new Promise(r => kid.once("exit", r));
  await drv.unmount(dir);
  await gone;
  assert.equal(drv.isMounted(dir), false);
});

test("the lock says in one line how many processes it stopped, and on the hard rounds skips a pid that is no longer the same process", async () => {
  const f = fake(["incomplete", "incomplete", "incomplete", "removed"]);
  const said = /** @type {string[]} */ ([]);
  await lockUntilComplete({ ...f.d, log: m => said.push(m), same: pid => pid === 7 });
  assert.deepEqual(f.killed.filter(k => k[1] === "SIGKILL").map(k => k[0]), [7], "pid 9 was reused, so it is not killed");
  assert.ok(said.some(m => /stopped 6 processes/.test(m)), said.join("|"));
});

import { reportedState } from "./runner.js";
import { fscryptDriverForTest } from "./workspace.js";

test("a workspace whose lease has ended says locking until nothing can read it, then locked; an open or unknown lease says what it is", () => {
  assert.equal(reportedState("locked", true), "locking");
  assert.equal(reportedState("revoked", true), "locking");
  assert.equal(reportedState("locked", false), "locked");
  assert.equal(reportedState("revoked", false), "revoked");
  assert.equal(reportedState("open", true), "open");
  assert.equal(reportedState("none", false), "none");
});

test("fscrypt: a key that is only partly removed (incomplete) still counts as mounted, an absent one does not", t => {
  const base = fs.mkdtempSync(path.join(tempHome(t), "inc-"));
  fs.mkdirSync(path.join(base, "w", "enc"), { recursive: true });
  let answer = "present";
  const drv = fscryptDriverForTest(() => {}, () => answer);
  for (const [a, mounted] of [["present", true], ["incomplete", true], ["absent", false]]) { answer = a; assert.equal(drv.isMounted(path.join(base, "w")), mounted, a); }
  assert.equal(drv.isMounted(path.join(base, "nothing")), false, "no folder, not mounted");
});
