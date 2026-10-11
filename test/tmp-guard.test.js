// @ts-check
// test/tmp-guard.mjs itself: a leaked directory made between its own before/after invocations
// (keyed on the ppid of whoever runs it, so this nested run never touches the real pretest/
// posttest's own state) is reported, reaped (a live process at its vyred.pid is killed, then the
// directory removed), and the run is failed - so a leak from a killed test process is swept up
// automatically rather than sitting in $TMPDIR until someone notices by hand.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp-guard.mjs");

/** The guard reaps every folder that appears in its scratch between "before" and "after". Run against the shared SCRATCH it reaped the live rigs of other test files running at the same time (one of them lost its
 * fake/ folder mid-test), so it runs in a private temp folder of its own: TMPDIR names it, and scratch.mjs and the guard both follow TMPDIR. @param {import("node:test").TestContext} t */
function privateTmp(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "tg-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: tmp };
  const scratch = spawnSync(process.execPath, ["--input-type=module", "-e", `import("${new URL("./scratch.mjs", import.meta.url).href}").then(m => process.stdout.write(m.SCRATCH))`], { env }).stdout.toString();
  const guard = (/** @type {"before" | "after"} */ mode) => spawnSync(process.execPath, [GUARD, mode], { env });
  return { scratch, guard };
}

/** A process that stays alive until killed, to stand in for a leaked vyred. */
function stayAlive() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

test("tmp-guard: a leaked home with a live vyred.pid is killed, removed, and the run fails", async t => {
  const g = privateTmp(t);
  const before = g.guard("before");
  assert.equal(before.status, 0);

  const child = stayAlive();
  await new Promise(r => setTimeout(r, 100)); // let it actually start before we sample its pid
  const leaked = fs.mkdtempSync(path.join(g.scratch, "vyre-test-"));
  fs.writeFileSync(path.join(leaked, "vyred.pid"), String(child.pid));
  t.after(() => { try { process.kill(/** @type {number} */ (child.pid), "SIGKILL"); } catch {} fs.rmSync(leaked, { recursive: true, force: true }); });

  const after = g.guard("after");
  assert.equal(after.status, 1, after.stderr.toString());
  assert.match(after.stderr.toString(), /never cleaned up/);
  assert.equal(fs.existsSync(leaked), false, "tmp-guard should have removed the leaked home");
  // We are child's own parent, so kill(pid, 0) alone can read a signalled-but-not-yet-reaped
  // process as still "alive" (a zombie still holds its pid slot until we wait() on it): ask
  // node's own exit bookkeeping instead of the raw signal, since a SIGKILL is not instant.
  for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(child.exitCode !== null || child.signalCode !== null, "tmp-guard should have killed the process holding vyred.pid");
});

test("tmp-guard: a clean run between before and after reports nothing and exits 0", t => {
  const g = privateTmp(t);
  const before = g.guard("before");
  assert.equal(before.status, 0);
  const after = g.guard("after");
  assert.equal(after.status, 0, after.stderr.toString());
  assert.equal(after.stderr.toString(), "");
});
