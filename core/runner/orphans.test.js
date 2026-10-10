// @ts-check
// Sessions a dead runner left running: the next runner ends all of them, a watchdog ends its own Space's, and a record whose process is something else now is left alone.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { endOrphans } from "./orphans.js";
import { watch } from "./watchdog.js";

const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (/** @type {() => boolean} */ f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 25)); } return f(); };

function world(/** @type {import("node:test").TestContext} */ t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orph-")); fs.mkdirSync(path.join(base, "run"), { recursive: true });
  const kids = /** @type {import("node:child_process").ChildProcess[]} */ ([]);
  t.after(() => { for (const k of kids) { try { process.kill(-Number(k.pid), "SIGKILL"); } catch { /* gone */ } } fs.rmSync(base, { recursive: true, force: true }); });
  /** A session left running: its own process group, and the record the runner wrote for it. */
  const left = (/** @type {string} */ space, /** @type {string} */ name) => {
    const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); c.unref(); kids.push(c);
    fs.writeFileSync(path.join(base, "run", `${space}.${name}.pid`), JSON.stringify({ pid: c.pid, session: name }));
    return /** @type {number} */ (c.pid);
  };
  return { base, left };
}

test("a restarted runner ends every session the dead one left, and forgets their records", async t => {
  const w = world(t), a = w.left("aaaa", "s1"), b = w.left("bbbb", "s2");
  assert.equal(endOrphans(w.base), 2);
  assert.ok(await until(() => !alive(a) && !alive(b)), "both are gone");
  assert.deepEqual(fs.readdirSync(path.join(w.base, "run")), []);
});

test("a watchdog ends only its own Space's sessions", async t => {
  const w = world(t), a = w.left("aaaa", "s1"), b = w.left("bbbb", "s2");
  assert.equal(endOrphans(w.base, "aaaa"), 1);
  assert.ok(await until(() => !alive(a)));
  assert.equal(alive(b), true, "another Space's session is not its business");
  assert.deepEqual(fs.readdirSync(path.join(w.base, "run")), ["bbbb.s2.pid"]);
});

test("the watchdog ends the Space's orphans when its runner is gone, not when only the deadline passed", async t => {
  const w = world(t);
  const dir = path.join(w.base, "spaces", "aaaa"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(w.base, "deadline"); fs.writeFileSync(f, JSON.stringify({ gen: "g", at: Date.now() + 3_600_000 }));
  const drv = { mounted: true, isMounted() { return this.mounted; }, async unmount() { this.mounted = false; } };
  /** @type {any[]} */ const ended = [];
  assert.equal(await watch({ driver: drv, dir, pid: 1, deadlineFile: f, isAlive: () => false, pollMs: 5, gen: "g", endOrphans: (b, only) => { ended.push([b, only]); return 1; } }), "unmounted");
  assert.deepEqual(ended, [[w.base, "aaaa"]], "the runner is gone: its Space's sessions are ended first");
  drv.mounted = true; fs.writeFileSync(f, JSON.stringify({ gen: "g", at: Date.now() - 1 }));
  assert.equal(await watch({ driver: drv, dir, pid: 1, deadlineFile: f, isAlive: () => true, pollMs: 5, gen: "g", endOrphans: () => { throw new Error("must not run"); } }), "unmounted");
});

test("a record that is not a process we can read, or whose pid is gone, is cleared and harms nothing", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orph-")); fs.mkdirSync(path.join(base, "run"));
  fs.writeFileSync(path.join(base, "run", "aaaa.x.pid"), "not json"); fs.writeFileSync(path.join(base, "run", "aaaa.y.pid"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal(endOrphans(base), 0);
  assert.deepEqual(fs.readdirSync(path.join(base, "run")), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a record whose pid now belongs to a different process (another start time) is left alone", async t => {
  const w = world(t), pid = w.left("aaaa", "s1");
  const file = path.join(w.base, "run", "aaaa.s1.pid");
  fs.writeFileSync(file, JSON.stringify({ pid, started: "not-when-it-started", session: "s1" }));
  assert.equal(endOrphans(w.base), 0);
  assert.equal(alive(pid), true, "somebody else's process is not ours to end");
  assert.deepEqual(fs.readdirSync(path.join(w.base, "run")), [], "the stale record is cleared");
});
