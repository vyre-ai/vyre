// @ts-check
// The pure parsers exhaustively; the IO wrappers (CpuSampler.linux, ramNow, diskNow, NetSampler,
// gpuNow) against real temp files standing in for /sys/fs/cgroup, /proc and /sys/class/net, the
// same split core/names/tailscale.js uses for run() vs parseStatus(). Nothing here touches the
// real /proc, /sys or the network.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseCgroupCpuStat, parseCgroupCpuMax, parseProcStat, procStatPercent, parseMeminfo,
  parseNvidiaSmi, parseMacTopCpu, CpuSampler, NetSampler, ramNow, diskNow, batteryNow, gpuNow,
} from "./collect.js";
import { SCRATCH } from "../../test/scratch.mjs";

const write = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const tmp = t => { const d = fs.mkdtempSync(path.join(SCRATCH, "vitals-collect-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test("parseCgroupCpuStat: usage_usec, or null without one", () => {
  assert.equal(parseCgroupCpuStat("usage_usec 12345678\nuser_usec 1\nsystem_usec 2\n"), 12345678);
  assert.equal(parseCgroupCpuStat("nr_periods 0\n"), null);
  assert.equal(parseCgroupCpuStat(""), null);
});

test("parseCgroupCpuMax: quota/period, max is unlimited (null)", () => {
  assert.equal(parseCgroupCpuMax("200000 100000\n"), 2);
  assert.equal(parseCgroupCpuMax("max 100000\n"), null);
  assert.equal(parseCgroupCpuMax("garbage"), null);
});

test("parseProcStat and procStatPercent: two samples, the busy fraction across every core", () => {
  const a = parseProcStat("cpu  100 0 50 850 0 0 0 0\ncpu0 ...\n");
  const b = parseProcStat("cpu  200 0 100 950 0 0 0 0\n");
  assert.deepEqual(a, { total: 1000, idle: 850 });
  assert.deepEqual(b, { total: 1250, idle: 950 });
  // total delta 250, idle delta 100: busy 150/250 = 60%
  assert.equal(procStatPercent(a, b), 60);
  assert.equal(procStatPercent(a, a), null, "no elapsed time, no delta: unknown, not a divide-by-zero 0");
  assert.equal(parseProcStat("nothing here"), null);
});

test("parseMeminfo: MemTotal and MemAvailable in bytes", () => {
  assert.deepEqual(parseMeminfo("MemTotal:       16384000 kB\nMemFree:         100000 kB\nMemAvailable:   8192000 kB\n"),
    { total: 16384000 * 1024, available: 8192000 * 1024 });
  assert.deepEqual(parseMeminfo("MemTotal:  2048 kB\n"), { total: 2048 * 1024, available: null });
  assert.equal(parseMeminfo(""), null);
});

test("parseNvidiaSmi: one GPU, several averaged, garbage lines dropped", () => {
  assert.equal(parseNvidiaSmi("23, 512, 8192\n"), 23);
  assert.equal(parseNvidiaSmi("20, 1, 2\n40, 1, 2\n"), 30);
  assert.equal(parseNvidiaSmi(""), null);
  assert.equal(parseNvidiaSmi("not a csv line\n"), null);
});

test("parseMacTopCpu: the last CPU usage line, idle to busy", () => {
  assert.equal(parseMacTopCpu("CPU usage: 12.5% user, 5.0% sys, 82.5% idle\n"), 17.5);
  assert.equal(parseMacTopCpu("CPU usage: 10% user, 5% sys, 85% idle\nCPU usage: 20% user, 10% sys, 70% idle\n"), 30, "the later of two samples wins");
  assert.equal(parseMacTopCpu("nothing"), null);
});

test("CpuSampler.linux: cgroup v2 first, two reads for a delta, null on the first", async t => {
  const dir = tmp(t);
  write(dir, "cgroup/cpu.stat", "usage_usec 1000000\n");
  write(dir, "cgroup/cpu.max", "200000 100000\n"); // a 2-CPU cap
  let clock = 0;
  const s = new CpuSampler({ platform: "linux", cgroup: path.join(dir, "cgroup"), proc: path.join(dir, "proc"), now: () => clock });
  const first = await s.read();
  assert.deepEqual(first, { cpu: null }, "one sample alone cannot make a rate");
  clock = 1000; // one second later
  write(dir, "cgroup/cpu.stat", "usage_usec 3000000\n"); // 2,000,000 usec of CPU time used in that second
  const second = await s.read();
  // 2,000,000 usec over 1,000,000 usec elapsed, over a 2-CPU cap: 100%.
  assert.equal(second.cpu, 100);
});

test("CpuSampler.linux: falls back to /proc/stat with why, when there is no cgroup v2", async t => {
  const dir = tmp(t);
  write(dir, "proc/stat", "cpu  100 0 50 850 0 0 0 0\n");
  const s = new CpuSampler({ platform: "linux", cgroup: path.join(dir, "no-such-cgroup"), proc: path.join(dir, "proc") });
  const first = await s.read();
  assert.equal(first.cpu, null);
  assert.match(first.why, /no cgroup v2/);
  write(dir, "proc/stat", "cpu  200 0 100 950 0 0 0 0\n");
  const second = await s.read();
  assert.equal(second.cpu, 60);
  assert.match(second.why, /no cgroup v2/);
});

test("CpuSampler.linux: neither cgroup nor /proc/stat readable", async t => {
  const dir = tmp(t);
  const s = new CpuSampler({ platform: "linux", cgroup: path.join(dir, "a"), proc: path.join(dir, "b") });
  const r = await s.read();
  assert.equal(r.cpu, null);
  assert.match(r.why, /neither cgroup v2 nor .proc.stat/);
});

test("CpuSampler.mac and .windows call the platform's own reader through the injected exec, and never on linux", async t => {
  const calls = [];
  const fakeExec = (cmd, args, opts, cb) => { calls.push([cmd, args]); cb(null, "CPU usage: 25% user, 5% sys, 70% idle\n"); };
  const mac = new CpuSampler({ platform: "darwin", exec: fakeExec });
  assert.deepEqual(await mac.read(), { cpu: 30 });
  assert.equal(calls[0][0], "top");
  const fakeExec2 = (cmd, args, opts, cb) => { calls.push([cmd, args]); cb(null, "42.5\n"); };
  const win = new CpuSampler({ platform: "win32", exec: fakeExec2 });
  assert.deepEqual(await win.read(), { cpu: 42.5 });
  assert.equal(calls[1][0], "powershell");
});

test("ramNow: cgroup v2 memory.current/max, falling back to /proc/meminfo, in bytes-percent", async t => {
  const dir = tmp(t);
  write(dir, "cgroup/memory.current", "1073741824\n"); // 1 GiB
  write(dir, "cgroup/memory.max", "4294967296\n"); // 4 GiB: 25%
  assert.deepEqual(await ramNow({ platform: "linux", cgroup: path.join(dir, "cgroup"), proc: path.join(dir, "proc") }), { ram: 25 });

  const dir2 = tmp(t);
  write(dir2, "cgroup/memory.current", "1073741824\n");
  write(dir2, "cgroup/memory.max", "max\n");
  write(dir2, "proc/meminfo", "MemTotal:       16384000 kB\nMemAvailable:   4096000 kB\n"); // used 75%
  const r2 = await ramNow({ platform: "linux", cgroup: path.join(dir2, "cgroup"), proc: path.join(dir2, "proc") });
  assert.equal(r2.ram, 75);
  assert.match(r2.why, /no cgroup v2 memory.max \(unlimited/);

  const dir3 = tmp(t);
  const r3 = await ramNow({ platform: "linux", cgroup: path.join(dir3, "cgroup"), proc: path.join(dir3, "proc") });
  assert.equal(r3.ram, null);
  assert.match(r3.why, /no cgroup v2 memory.max and .proc.meminfo/);

  assert.match((await ramNow({ platform: "win32" })).why, /not built yet/);
});

test("diskNow: real statfs on this machine's own tmp, and a path that does not exist", async t => {
  const dir = tmp(t);
  const r = diskNow(dir);
  assert.equal(typeof r.disk, "number");
  assert.ok(r.disk >= 0 && r.disk <= 100);
  const bad = diskNow(path.join(dir, "does", "not", "exist"));
  assert.equal(bad.disk, null);
  assert.match(bad.why, /statfs/);
});

test("NetSampler: two reads for a rate, summed across every interface but lo, null on the first", async t => {
  const dir = tmp(t);
  write(dir, "eth0/statistics/rx_bytes", "1000\n");
  write(dir, "eth0/statistics/tx_bytes", "500\n");
  write(dir, "lo/statistics/rx_bytes", "999999\n"); // excluded: loopback is not the network
  write(dir, "lo/statistics/tx_bytes", "999999\n");
  let clock = 0;
  const s = new NetSampler({ sysNet: dir, platform: "linux", now: () => clock });
  assert.deepEqual(s.read(), { netRx: null, netTx: null });
  clock = 1000; // one second later
  write(dir, "eth0/statistics/rx_bytes", "3000\n");
  write(dir, "eth0/statistics/tx_bytes", "1500\n");
  const r = s.read();
  assert.equal(r.netRx, 2000);
  assert.equal(r.netTx, 1000);
});

test("NetSampler: an unreadable /sys/class/net says why, and never on a platform this has not built", () => {
  const s = new NetSampler({ sysNet: "/no/such/dir", platform: "linux" });
  assert.match(s.read().why, /is not readable/);
  const win = new NetSampler({ platform: "win32" });
  assert.match(win.read().why, /not built yet/);
});

test("batteryNow: none on the server, not built elsewhere yet", () => {
  assert.deepEqual(batteryNow("linux"), { battery: null, why: "no battery" });
  assert.match(batteryNow("darwin").why, /not built yet/);
});

test("gpuNow: nvidia-smi through the injected exec; ENOENT means no GPU, not an error", async () => {
  const ok = await gpuNow({ platform: "linux", exec: (cmd, args, opts, cb) => cb(null, "17, 100, 8192\n") });
  assert.deepEqual(ok, { gpu: 17 });
  const none = await gpuNow({ platform: "linux", exec: (cmd, args, opts, cb) => cb(Object.assign(new Error("not found"), { code: "ENOENT" })) });
  assert.deepEqual(none, { gpu: null, why: "no GPU" });
  const broken = await gpuNow({ platform: "linux", exec: (cmd, args, opts, cb) => cb(new Error("boom")) });
  assert.match(broken.why, /nvidia-smi: boom/);
  assert.match((await gpuNow({ platform: "win32" })).why, /not built yet/);
});
