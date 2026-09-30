// @ts-check
// test/tmp-guard.mjs itself: a leaked directory made between its own before/after invocations
// (keyed on the ppid of whoever runs it, so this nested run never touches the real pretest/
// posttest's own state) is reported, reaped (a live process at its vyred.pid is killed, then the
// directory removed), and the run is failed - so a leak from a killed test process is swept up
// automatically rather than sitting in $TMPDIR until someone notices by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp-guard.mjs");

/** A process that stays alive until killed, to stand in for a leaked vyred. */
function stayAlive() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

test("tmp-guard: a leaked home with a live vyred.pid is killed, removed, and the run fails", async t => {
  const before = spawnSync(process.execPath, [GUARD, "before"]);
  assert.equal(before.status, 0);

  const child = stayAlive();
  await new Promise(r => setTimeout(r, 100)); // let it actually start before we sample its pid
  const leaked = fs.mkdtempSync(path.join(SCRATCH, "vyre-test-"));
  fs.writeFileSync(path.join(leaked, "vyred.pid"), String(child.pid));
  t.after(() => { try { process.kill(/** @type {number} */ (child.pid), "SIGKILL"); } catch {} fs.rmSync(leaked, { recursive: true, force: true }); });

  const after = spawnSync(process.execPath, [GUARD, "after"]);
  assert.equal(after.status, 1, after.stderr.toString());
  assert.match(after.stderr.toString(), /never cleaned up/);
  assert.equal(fs.existsSync(leaked), false, "tmp-guard should have removed the leaked home");
  // We are child's own parent, so kill(pid, 0) alone can read a signalled-but-not-yet-reaped
  // process as still "alive" (a zombie still holds its pid slot until we wait() on it): ask
  // node's own exit bookkeeping instead of the raw signal, since a SIGKILL is not instant.
  for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(child.exitCode !== null || child.signalCode !== null, "tmp-guard should have killed the process holding vyred.pid");
});

test("tmp-guard: a clean run between before and after reports nothing and exits 0", () => {
  const before = spawnSync(process.execPath, [GUARD, "before"]);
  assert.equal(before.status, 0);
  const after = spawnSync(process.execPath, [GUARD, "after"]);
  assert.equal(after.status, 0, after.stderr.toString());
  assert.equal(after.stderr.toString(), "");
});
