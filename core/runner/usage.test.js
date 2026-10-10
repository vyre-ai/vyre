// @ts-check
// What a session uses: the process group's processor from its CPU time between two samples, and its resident memory, on Linux from /proc and on macOS from ps.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createUsage } from "./usage.js";

/** A /proc stat line: pid (comm) state ppid pgrp ... utime stime ... rss. */
const stat = (pid, comm, pgrp, utime, stime, rssPages) => {
  const f = Array(52).fill("0"); f[0] = String(pid); f[1] = `(${comm})`; f[2] = "S"; f[3] = "1"; f[4] = String(pgrp); f[13] = String(utime); f[14] = String(stime); f[23] = String(rssPages);
  return f.join(" ");
};

test("linux: the group's processor is its CPU time over the time between samples, and its memory the resident pages; other groups do not count", () => {
  let t = 0, tick = 0;
  const table = () => ({ "10": stat(10, "agent", 10, tick * 50, tick * 25, 25600), "11": stat(11, "node (child)", 10, tick * 25, 0, 12800), "20": stat(20, "other", 20, tick * 999, 0, 99999) });
  const u = createUsage({ platform: "linux", now: () => t, proc: { pids: () => Object.keys(table()), stat: pid => /** @type {any} */ (table())[pid] ?? null } });
  assert.deepEqual(u.sample(10), { cpuPercent: 0, memoryMb: 150 }, "the first sample has nothing to compare with: 0%, and 38 400 pages of 4 KB is 150 MB");
  t += 2000; tick = 1;   // two seconds later the group used 100 ticks = 1 second of CPU
  assert.equal(u.sample(10).cpuPercent, 50, "one CPU-second in two seconds is 50% of one core");
  t += 1000; tick = 3;   // 200 ticks = 2 seconds in 1 second: two cores' worth
  assert.equal(u.sample(10).cpuPercent, 200);
  u.forget(10); t += 1000; tick = 4;
  assert.equal(u.sample(10).cpuPercent, 0, "a forgotten group starts again");
});

test("linux: a process with spaces and brackets in its name does not shift the fields, and a process that vanished is skipped", () => {
  const u = createUsage({ platform: "linux", now: () => 0, proc: { pids: () => ["1", "2"], stat: pid => (pid === "1" ? stat(1, "a (b) c", 7, 5, 5, 256) : null) } });
  assert.equal(u.sample(7).memoryMb, 1);
});

test("macos: ps gives the group's percent and resident memory, summed", () => {
  const out = "   10   12.5  204800\n   10    7.5  102400\n   99   80.0  999999\n garbage\n";
  const u = createUsage({ platform: "darwin", ps: () => out });
  assert.deepEqual(u.sample(10), { cpuPercent: 20, memoryMb: 300 });
  assert.deepEqual(u.sample(5), { cpuPercent: 0, memoryMb: 0 });
});
