// @ts-check
// What a session uses: the whole process tree's processor from its CPU time between two samples, and its resident memory.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createUsage } from "./usage.js";

/** @param {number} pid @param {number} ppid @param {number} pgid @param {number} ticks @param {number} pages @returns {import("./proctree.js").Proc} */
const P = (pid, ppid, pgid, ticks, pages) => ({ pid, ppid, pgid, ticks, pages, pcpu: 0, kb: 0 });

test("linux: the tree's processor is its CPU time over the time between samples, its memory the resident pages; the agent in a process group of its own still counts, other trees do not", () => {
  let t = 0, tick = 0;
  // 10 is the wrapper Vyre started; the sandbox put its child 11 and grandchild 12 in another group (--new-session); 20 is somebody else's
  const table = () => [P(10, 1, 10, tick * 10, 2560), P(11, 10, 11, tick * 30, 5120), P(12, 11, 11, tick * 60, 28160), P(20, 1, 20, tick * 999, 99999)];
  const u = createUsage({ platform: "linux", now: () => t, procs: table });
  assert.deepEqual(u.sample(10), { cpuPercent: 0, memoryMb: 144 }, "the first sample has nothing to compare with: 0%, and 35 840 pages of 4 KB is 140 MB rounded up by the three processes");
  t += 2000; tick = 1;   // two seconds later the tree used 100 ticks = 1 second of CPU
  assert.equal(u.sample(10).cpuPercent, 50, "one CPU-second in two seconds is 50% of one core");
  t += 1000; tick = 3;   // 200 ticks in 1 second: two cores' worth
  assert.equal(u.sample(10).cpuPercent, 200);
  u.forget(10); t += 1000; tick = 4;
  assert.equal(u.sample(10).cpuPercent, 0, "a forgotten tree starts again");
});

test("macos: ps gives the tree's percent and resident memory, summed", () => {
  const procs = [{ pid: 10, ppid: 1, pgid: 10, ticks: 0, pages: 0, pcpu: 12.5, kb: 204800 }, { pid: 11, ppid: 10, pgid: 11, ticks: 0, pages: 0, pcpu: 7.5, kb: 102400 }, { pid: 99, ppid: 1, pgid: 99, ticks: 0, pages: 0, pcpu: 80, kb: 999999 }];
  const u = createUsage({ platform: "darwin", procs: () => procs });
  assert.deepEqual(u.sample(10), { cpuPercent: 20, memoryMb: 300 });
  assert.deepEqual(u.sample(5), { cpuPercent: 0, memoryMb: 0 });
});
