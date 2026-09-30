// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome } from "../../test/helpers.js";
import { acquire, startOf } from "./lock.js";
import { start } from "./index.js";
import { socketPath } from "../config/index.js";

const home = t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [] }));
  return root;
};

test("lock: a home reached through a symlink is the same home: one vyred, one socket", async t => {
  const root = home(t);
  const link = path.join(tempHome(t), "via-link");
  fs.symlinkSync(root, link);
  assert.equal(socketPath(link), socketPath(root));
  // A spelling long enough to move the socket to /tmp still lands on the target's socket.
  const deep = path.join(tempHome(t), "x".repeat(90));
  fs.symlinkSync(root, deep);
  assert.equal(socketPath(deep), socketPath(root));

  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await assert.rejects(start({ root: link, log: () => {} }), /vyred is already running/);
  await assert.rejects(start({ root: deep, log: () => {} }), /vyred is already running/);
  await d.stop();
  const again = await start({ root: link, log: () => {} });
  await again.stop();
  assert.equal(fs.existsSync(path.join(root, "vyred.lock")), false, "stop gives the lock back");
});

/**
 * A live process whose command line names vyre, so it reads as a vyre process on every OS (the
 * test's own parent is `node --test`, which names vyre only by where the repo sits).
 * @param {any} t
 */
function vyreProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "vyre-lock-holder"], { stdio: "ignore" });
  t.after(() => child.kill());
  return /** @type {number} */ (child.pid);
}

test("lock: another live vyre process holds it; a dead one, or one from before this boot, does not", t => {
  const root = home(t);
  const file = path.join(fs.realpathSync(root), "vyred.lock");
  const boot = Math.round((Date.now() - os.uptime() * 1000) / 60_000);
  // A pid that is certainly gone.
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, boot }));
  const r1 = acquire(root);
  r1();
  const live = vyreProcess(t);
  fs.writeFileSync(file, JSON.stringify({ pid: live, boot }));
  assert.throws(() => acquire(root), /already running \(pid/);
  // The same pid from an earlier boot is someone else now.
  fs.writeFileSync(file, JSON.stringify({ pid: live, boot: boot - 600 }));
  const r2 = acquire(root);
  assert.throws(() => acquire(root), /already running in this process/);
  r2();
  assert.equal(fs.existsSync(file), false);
});

test("lock: a pid another process reuses (a box container replaced, the same boot) does not hold it", t => {
  const root = home(t);
  const file = path.join(fs.realpathSync(root), "vyred.lock");
  const boot = Math.round((Date.now() - os.uptime() * 1000) / 60_000);
  const live = vyreProcess(t);
  const started = startOf(live);
  assert.ok(started, "the kernel says when the process started");
  // The lock's vyred started at another time: this live pid is someone else now.
  fs.writeFileSync(file, JSON.stringify({ pid: live, boot, started: `${started}0` }));
  const r = acquire(root);
  r();
  // The process that took it, still running, holds it.
  fs.writeFileSync(file, JSON.stringify({ pid: live, boot, started }));
  assert.throws(() => acquire(root), /already running \(pid/);
  fs.rmSync(file, { force: true });
});
