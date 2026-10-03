// @ts-check
// collect: one CPU/RAM/disk/network/battery/GPU sample, per platform.
//
// Every read here is something the OS already answers to an unprivileged process (no root, no
// permission prompt): cgroup v2 files and /proc on Linux, ioreg and pmset on the Mac, perf
// counters and WMI on Windows. Each platform's IO (readFileSync, execFile) is a thin wrapper
// around a pure parser, the same split core/names/tailscale.js uses for `status --json` (run vs
// parseStatus): the parsers are what tests exercise; the IO wrappers are one line each so there
// is as little unverified surface as possible (docs/design/vitals.md, "Depends on" 4).
//
// The server runs inside a container (box/Dockerfile), so "this machine" for cpu/ram means the
// container's own cgroup, not the host's: cgroup v2 (cpu.stat, memory.current, memory.max) when
// mounted, else a host-wide /proc fallback with a `why` saying so, since a host-wide number would
// mislead whoever reads a "the server is at 90%" tile.

import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";

const CGROUP = "/sys/fs/cgroup";
const PROC = "/proc";
const SYS_NET = "/sys/class/net";

/** Anything not a finite number is null, never NaN or a stringly "NaN%" on a tile. */
const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;

// ---- CPU --------------------------------------------------------------------------------

/**
 * Pure: cgroup v2's cpu.stat ("usage_usec 123..." lines) to the usec figure, or null when the
 * file has no such key (cgroup v1, or a line format this never saw).
 * @param {string} text
 */
export function parseCgroupCpuStat(text) {
  const m = /^usage_usec\s+(\d+)/m.exec(String(text || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Pure: cgroup v2's cpu.max ("<quota> <period>" or "max <period>") to the number of CPUs it
 * caps this container to, or null when it is "max" (unlimited: fall back to the host's count).
 * @param {string} text
 */
export function parseCgroupCpuMax(text) {
  const m = /^(\S+)\s+(\d+)/.exec(String(text || "").trim());
  if (!m || m[1] === "max") return null;
  const quota = Number(m[1]), period = Number(m[2]);
  return Number.isFinite(quota) && Number.isFinite(period) && period > 0 ? quota / period : null;
}

/**
 * Pure: /proc/stat's first line ("cpu  user nice system idle iowait irq softirq steal") to the
 * total jiffies and the idle ones, for a host-wide fallback when there is no cgroup v2.
 * @param {string} text
 */
export function parseProcStat(text) {
  const line = String(text || "").split("\n").find(l => l.startsWith("cpu "));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.some(x => !Number.isFinite(x))) return null;
  const idle = (f[3] || 0) + (f[4] || 0);
  return { total: f.reduce((a, b) => a + b, 0), idle };
}

/**
 * Pure: two /proc/stat samples to a CPU percentage across every core (0 to 100 * nproc, so a
 * caller divides by online CPUs itself, matching Docker's own stats reducer).
 * @param {{ total: number, idle: number }} prev @param {{ total: number, idle: number }} curr
 */
export function procStatPercent(prev, curr) {
  const totalDelta = curr.total - prev.total, idleDelta = curr.idle - prev.idle;
  if (!(totalDelta > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100 * 10) / 10));
}

/**
 * A CPU sampler that keeps its own previous reading (a percentage needs two points in time), for
 * the platform passed at construction. `read()` on Linux prefers cgroup v2's cpu.stat/cpu.max
 * (this container's own share), and falls back to /proc/stat host-wide with `why` set.
 */
export class CpuSampler {
  /** @param {{ platform?: string, cgroup?: string, proc?: string, exec?: typeof execFile, now?: () => number }} [o] */
  constructor(o = {}) {
    this.platform = o.platform || process.platform;
    this.cgroup = o.cgroup || CGROUP;
    this.proc = o.proc || PROC;
    this.exec = o.exec || execFile;
    this.now = o.now || Date.now;
    /** @type {{ at: number, usec?: number, stat?: { total: number, idle: number } } | null} */
    this.prev = null;
  }

  /** @returns {Promise<{ cpu: number|null, why?: string }>} */
  async read() {
    if (this.platform === "darwin") return this.mac();
    if (this.platform === "win32") return this.windows();
    return this.linux();
  }

  linux() {
    const at = this.now();
    let usec = null, why;
    try { usec = parseCgroupCpuStat(fs.readFileSync(`${this.cgroup}/cpu.stat`, "utf8")); } catch {}
    if (usec !== null) {
      let cpus = null;
      try { cpus = parseCgroupCpuMax(fs.readFileSync(`${this.cgroup}/cpu.max`, "utf8")); } catch {}
      const online = cpus || osCpuCount();
      const prev = this.prev && this.prev.usec !== undefined ? this.prev : null;
      this.prev = { at, usec };
      if (!prev) return { cpu: null };
      const elapsedUsec = (at - prev.at) * 1000;
      if (!(elapsedUsec > 0)) return { cpu: null };
      const cpu = Math.max(0, Math.min(100, Math.round((usec - prev.usec) / elapsedUsec / online * 100 * 10) / 10));
      return { cpu };
    }
    why = "no cgroup v2 (cpu.stat); reading /proc/stat host-wide, which may not match this container's own share";
    let stat = null;
    try { stat = parseProcStat(fs.readFileSync(`${this.proc}/stat`, "utf8")); } catch {}
    if (!stat) return { cpu: null, why: "neither cgroup v2 nor /proc/stat answered" };
    const prev = this.prev && this.prev.stat ? this.prev.stat : null;
    this.prev = { at, stat };
    if (!prev) return { cpu: null, why };
    return { cpu: procStatPercent(prev, stat), why };
  }

  /** ioreg's own CPU line is unreliable across chip generations; host_processor_info (via `top -l 1`) is Capsule's existing reader, reused rather than duplicated. Unverified here: no real Mac to run against (docs/design/vitals.md, item 4). */
  async mac() {
    return new Promise(resolve => {
      this.exec("top", ["-l", "2", "-n", "0"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ cpu: null, why: `top failed: ${err.message}` });
        resolve({ cpu: parseMacTopCpu(String(stdout)) });
      });
    });
  }

  /** Unverified here: no real Windows device to run against (docs/design/vitals.md, item 4). */
  async windows() {
    return new Promise(resolve => {
      this.exec("powershell", ["-NoProfile", "-Command",
        "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue"],
        { timeout: 5000 }, (err, stdout) => {
          if (err) return resolve({ cpu: null, why: `Get-Counter failed: ${err.message}` });
          const n = Number(String(stdout).trim());
          resolve({ cpu: num(n) !== null ? Math.round(n * 10) / 10 : null });
        });
    });
  }
}

/** Pure: the last "CPU usage: NN.N% user, NN.N% sys, NN.N% idle" line from `top -l 2 -n 0`. */
export function parseMacTopCpu(text) {
  const lines = String(text || "").split("\n").filter(l => /^CPU usage:/.test(l));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const m = /([\d.]+)%\s*idle/.exec(line);
  return m ? Math.round((100 - Number(m[1])) * 10) / 10 : null;
}

function osCpuCount() {
  try { return Math.max(1, os.cpus().length); } catch { return 1; }
}

// ---- RAM ----------------------------------------------------------------------------------

/**
 * Pure: /proc/meminfo ("MemTotal:  16384000 kB" lines) to total and available bytes, or null.
 * @param {string} text
 */
export function parseMeminfo(text) {
  const kv = {};
  for (const m of String(text || "").matchAll(/^(\w+):\s+(\d+)\s*kB/gm)) kv[m[1]] = Number(m[2]) * 1024;
  return kv.MemTotal ? { total: kv.MemTotal, available: kv.MemAvailable ?? null } : null;
}

/**
 * @param {{ cgroup?: string, proc?: string, platform?: string, exec?: typeof execFile }} [o]
 * @returns {Promise<{ ram: number|null, why?: string }>}
 */
export async function ramNow(o = {}) {
  const platform = o.platform || process.platform;
  if (platform === "linux") {
    let current = null, max = null;
    try { current = Number(fs.readFileSync(`${o.cgroup || CGROUP}/memory.current`, "utf8").trim()); } catch {}
    try { const t = fs.readFileSync(`${o.cgroup || CGROUP}/memory.max`, "utf8").trim(); max = t === "max" ? null : Number(t); } catch {}
    if (num(current) !== null && num(max)) return { ram: Math.round(current / max * 100 * 10) / 10 };
    let mem = null;
    try { mem = parseMeminfo(fs.readFileSync(`${o.proc || PROC}/meminfo`, "utf8")); } catch {}
    if (!mem || mem.available === null) return { ram: null, why: "no cgroup v2 memory.max and /proc/meminfo had no MemAvailable" };
    return { ram: Math.round((1 - mem.available / mem.total) * 100 * 10) / 10, why: "no cgroup v2 memory.max (unlimited or absent); using the host's total" };
  }
  return { ram: null, why: `ram on ${platform}: not built yet (docs/design/vitals.md, item 4)` };
}

// ---- Disk --------------------------------------------------------------------------------

/**
 * @param {string} path @returns {{ disk: number|null, why?: string }}
 */
export function diskNow(path) {
  try {
    const s = fs.statfsSync(path);
    const total = s.blocks * s.bsize, free = s.bfree * s.bsize;
    if (!(total > 0)) return { disk: null };
    return { disk: Math.round((1 - free / total) * 100 * 10) / 10 };
  } catch (e) { return { disk: null, why: `statfs ${path}: ${/** @type {Error} */ (e).message}` }; }
}

// ---- Network ------------------------------------------------------------------------------

/** Pure: one interface's rx_bytes/tx_bytes file content to a number, or null. */
const parseCounter = text => { const n = Number(String(text || "").trim()); return Number.isFinite(n) ? n : null; };

/** A network sampler with its own previous reading, for the bytes/sec rate. */
export class NetSampler {
  /** @param {{ sysNet?: string, platform?: string, now?: () => number }} [o] */
  constructor(o = {}) {
    this.sysNet = o.sysNet || SYS_NET;
    this.platform = o.platform || process.platform;
    this.now = o.now || Date.now;
    /** @type {{ at: number, rx: number, tx: number } | null} */
    this.prev = null;
  }

  read() {
    if (this.platform !== "linux") return { netRx: null, netTx: null, why: `network on ${this.platform}: not built yet` };
    let ifaces = [];
    try { ifaces = fs.readdirSync(this.sysNet).filter(n => n !== "lo"); } catch { return { netRx: null, netTx: null, why: `${this.sysNet} is not readable` }; }
    let rx = 0, tx = 0;
    for (const i of ifaces) {
      try {
        rx += parseCounter(fs.readFileSync(`${this.sysNet}/${i}/statistics/rx_bytes`, "utf8")) || 0;
        tx += parseCounter(fs.readFileSync(`${this.sysNet}/${i}/statistics/tx_bytes`, "utf8")) || 0;
      } catch {}
    }
    const at = this.now();
    const prev = this.prev;
    this.prev = { at, rx, tx };
    if (!prev) return { netRx: null, netTx: null };
    const elapsedS = (at - prev.at) / 1000;
    if (!(elapsedS > 0)) return { netRx: null, netTx: null };
    return { netRx: Math.round((rx - prev.rx) / elapsedS), netTx: Math.round((tx - prev.tx) / elapsedS) };
  }
}

// ---- Battery ------------------------------------------------------------------------------

/** The server has none; a Mac or Windows device's reader lands with those platforms (item 4). */
export function batteryNow(platform = process.platform) {
  if (platform === "linux") return { battery: null, why: "no battery" };
  return { battery: null, why: `battery on ${platform}: not built yet (docs/design/vitals.md, item 4)` };
}

// ---- GPU ----------------------------------------------------------------------------------

const GPU_RECHECK_MS = 3_600_000;
const gpuState = { none: 0 };

/**
 * Pure: one `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total
 * --format=csv,noheader,nounits` line ("23, 512, 8192") to a percentage. Several GPUs average.
 * @param {string} text
 */
export function parseNvidiaSmi(text) {
  const rows = String(text || "").trim().split("\n").map(l => l.split(",").map(x => Number(x.trim()))).filter(r => r.length === 3 && r.every(Number.isFinite));
  if (!rows.length) return null;
  return Math.round(rows.reduce((a, r) => a + r[0], 0) / rows.length * 10) / 10;
}

/**
 * A machine with no nvidia-smi is not asked again for an hour: the failed spawn forks the whole daemon once a minute, which was the idle CPU blip of #71.
 * @param {{ platform?: string, exec?: typeof execFile, state?: { none: number }, now?: () => number }} [o]
 * @returns {Promise<{ gpu: number|null, why?: string }>}
 */
export async function gpuNow(o = {}) {
  const platform = o.platform || process.platform;
  const exec = o.exec || execFile;
  const state = o.state || gpuState, now = (o.now || Date.now)();
  if (platform === "linux") {
    if (state.none && now - state.none < GPU_RECHECK_MS) return { gpu: null, why: "no GPU" };
    return new Promise(resolve => {
      exec("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 }, (err, stdout) => {
        if (err && err.code === "ENOENT") state.none = now;
        if (err) return resolve({ gpu: null, why: err.code === "ENOENT" ? "no GPU" : `nvidia-smi: ${err.message}` });
        resolve({ gpu: parseNvidiaSmi(String(stdout)) });
      });
    });
  }
  return { gpu: null, why: `gpu on ${platform}: not built yet (docs/design/vitals.md, item 4)` };
}
