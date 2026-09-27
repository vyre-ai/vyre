// @ts-check
// pace: how Recall's background work stays light (SPEC principle 8). A first index of someone's
// whole history is hours of work for the machine; done flat out it held a Mac at about 500% CPU
// for minutes and the machine glitched. So it runs as a trickle:
//
//   duty     after each piece of work, sleep long enough that the work is at most `duty` of the
//            wall clock (0.5: as long again as the piece took). With the model on one thread,
//            that keeps indexing near half of one core on average.
//   gate     no background work at all while the Mac is on battery under 30%, or the machine is
//            already busy (the 1-minute load average above the number of cores). Looked at no
//            more than once a minute, and said out loud in `vyre status`.
//
// Search never waits on any of this: keyword search works from the first indexed session, and
// meaning fills in as vectors land.

import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * A function to await after each piece of work, given how long the piece took.
 * @param {{ duty?: number, maxPauseMs?: number, sleep?: (ms: number) => Promise<unknown> }} [o]
 * @returns {(spentMs: number) => Promise<void>}
 */
export function pacer({ duty = 0.5, maxPauseMs = 5000, sleep: wait = sleep } = {}) {
  const d = Math.min(1, Math.max(0.05, duty));
  if (d >= 1) return async () => { await new Promise(r => setImmediate(r)); };
  return async spent => {
    const pause = Math.min(maxPauseMs, Math.max(1, spent * (1 - d) / d));
    await wait(pause);
  };
}

/**
 * The battery, where the OS says: { percent, charging } or null (no battery, or cannot tell).
 * macOS: `pmset -g batt`. Linux: /sys/class/power_supply.
 * @returns {Promise<{ percent: number, onBattery: boolean } | null>}
 */
export async function battery(platform = process.platform) {
  if (platform === "darwin") {
    const outText = await new Promise(r => execFile("pmset", ["-g", "batt"], { timeout: 2000 }, (e, o) => r(e ? "" : String(o))));
    return parsePmset(/** @type {string} */ (outText));
  }
  if (platform === "linux") {
    try {
      const bats = fs.readdirSync("/sys/class/power_supply").filter(n => n.startsWith("BAT"));
      if (!bats.length) return null;
      const dir = `/sys/class/power_supply/${bats[0]}`;
      const percent = Number(fs.readFileSync(`${dir}/capacity`, "utf8").trim());
      const status = fs.readFileSync(`${dir}/status`, "utf8").trim();
      return Number.isFinite(percent) ? { percent, onBattery: status === "Discharging" } : null;
    } catch { return null; }
  }
  return null;
}

/** Pure, for tests: `pmset -g batt` as { percent, onBattery }, or null for a Mac without a battery. */
export function parsePmset(text) {
  const m = /(\d+)%/.exec(text);
  if (!m) return null;
  return { percent: Number(m[1]), onBattery: /'Battery Power'/.test(text) };
}

/**
 * Why background work should wait right now, or null. Cached for `everyMs` so a busy loop can ask
 * as often as it likes and the OS is asked at most once a minute.
 * @param {{ lowBattery?: number, everyMs?: number, battery?: typeof battery, load?: () => number, cores?: number, now?: () => number }} [o]
 */
export function gate({ lowBattery = 30, everyMs = 60_000, battery: bat = battery, load = () => os.loadavg()[0], cores = os.availableParallelism?.() || os.cpus().length, now = Date.now } = {}) {
  /** @type {string | null} */
  let why = null;
  let at = -Infinity;
  /** @type {Promise<string | null> | null} */
  let asking = null;
  const ask = async () => {
    const l = load();
    if (l > cores) return `the machine is busy (load ${l.toFixed(1)} on ${cores} cores)`;
    const b = lowBattery > 0 ? await bat().catch(() => null) : null;
    if (b && b.onBattery && b.percent < lowBattery) return `on battery at ${b.percent}%`;
    return null;
  };
  return {
    /** The reason to wait, looked at again once `everyMs` has passed. */
    async check() {
      if (now() - at < everyMs) return why;
      if (!asking) asking = ask().then(w => { why = w; at = now(); asking = null; return w; });
      return asking;
    },
    /** The last answer, without asking. */
    get why() { return why; },
  };
}
