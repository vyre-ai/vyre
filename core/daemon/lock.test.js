// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { acquire } from "./lock.js";
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

test("lock: another live vyre process holds it; a dead one, or one from before this boot, does not", t => {
  const root = home(t);
  const file = path.join(fs.realpathSync(root), "vyred.lock");
  const boot = Math.round((Date.now() - os.uptime() * 1000) / 60_000);
  // A pid that is certainly gone.
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, boot }));
  const r1 = acquire(root);
  r1();
  // The parent of this test is a live node process under the repo, so it reads as vyre's.
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, boot }));
  if (/vyre/i.test(fs.existsSync(`/proc/${process.ppid}/cmdline`) ? fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8") : process.cwd())) {
    assert.throws(() => acquire(root), /already running \(pid/);
  }
  // The same pid from an earlier boot is someone else now.
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, boot: boot - 600 }));
  const r2 = acquire(root);
  assert.throws(() => acquire(root), /already running in this process/);
  r2();
  assert.equal(fs.existsSync(file), false);
});
