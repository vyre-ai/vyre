// @ts-check
// Where a session runs (DESIGN-local-runner section 7). Pure: it takes facts and answers with a place and a plain reason.
//
//   here    this computer, if both grants exist and the device's own limits allow it right now
//   server  the space's server, if this computer cannot and the server has room
//   wait    neither: the session waits, and the reason says why in words a person can act on
//
// A session pinned to the server never runs here ("keep running when I close my laptop"). "Move to server" is the
// same decision with the pin set, after a final checkpoint (runner.moveToServer).
//
// Both grants are the identity studs: Offer side space_allows (the space) and side member_accepts (this member, this device).
// Limits are the device page's: only when plugged in, only when awake, a CPU and a memory ceiling.

/**
 * @typedef {{ onPower: boolean, awake: boolean, cpuPct: number, memPct: number }} DeviceState
 * @typedef {{ onlyOnPower?: boolean, onlyAwake?: boolean, cpuMaxPct?: number, memMaxPct?: number }} DeviceLimits
 * @typedef {{ where: "here"|"server"|"wait", reason: string }} Placement
 */

export const DEFAULT_LIMITS = { onlyOnPower: true, onlyAwake: true, cpuMaxPct: 70, memMaxPct: 80 };

/**
 * Why this computer cannot take the session now, or "" when it can.
 * @param {{ spaceAllows: boolean, memberAccepts: boolean, state: DeviceState, limits?: DeviceLimits, runnerReady?: string }} o
 */
export function hereBlock(o) {
  const l = { ...DEFAULT_LIMITS, ...(o.limits || {}) };
  if (!o.spaceAllows) return "this space has not allowed members to run its work on their own computers";
  if (!o.memberAccepts) return "this computer is not set to run this space's work";
  if (o.runnerReady) return o.runnerReady;
  if (l.onlyAwake && !o.state.awake) return "this computer is asleep";
  if (l.onlyOnPower && !o.state.onPower) return "this computer is on battery and is set to run work only when plugged in";
  if (o.state.cpuPct > l.cpuMaxPct) return `this computer is busy (${Math.round(o.state.cpuPct)}% CPU, your limit is ${l.cpuMaxPct}%)`;
  if (o.state.memPct > l.memMaxPct) return `this computer is short of memory (${Math.round(o.state.memPct)}% used, your limit is ${l.memMaxPct}%)`;
  return "";
}

/**
 * @param {{ pinnedToServer?: boolean, spaceAllows: boolean, memberAccepts: boolean, state: DeviceState, limits?: DeviceLimits,
 *   runnerReady?: string, server?: { available: boolean, hasRoom: boolean, why?: string } }} o
 * @returns {Placement}
 */
export function place(o) {
  const block = o.pinnedToServer ? "this session is pinned to the server" : hereBlock(o);
  if (!block) return { where: "here", reason: "this computer is allowed, awake and has room" };
  const s = o.server;
  if (s && s.available && s.hasRoom) return { where: "server", reason: `on the space's server, because ${block}` };
  const why = !s ? "the space has no server" : !s.available ? (s.why || "the space's server is not reachable") : "the space's server is full";
  return { where: "wait", reason: `waiting: ${block}, and ${why}` };
}

/**
 * Read this computer's state. Injectable for tests.
 * @param {{ os?: any, run?: (cmd: string, args: string[]) => string, platform?: string }} [o]
 * @returns {DeviceState}
 */
export function deviceState(o = {}) {
  const os = o.os || nodeOs();
  const platform = o.platform || process.platform;
  const run = o.run || defaultRun;
  const cpus = os.cpus().length || 1;
  const cpuPct = Math.min(100, (os.loadavg()[0] / cpus) * 100);
  const memPct = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
  let onPower = true;
  try {
    if (platform === "darwin") onPower = /AC Power/.test(run("/usr/bin/pmset", ["-g", "batt"]));
    else if (platform === "linux") {
      const line = run("sh", ["-c", "cat /sys/class/power_supply/AC*/online /sys/class/power_supply/ADP*/online 2>/dev/null | head -1"]).trim();
      onPower = line === "" ? true : line === "1";
    }
  } catch {}
  // A process that is running is awake. A machine that is asleep is not running this code; the sleeper's session
  // continues from its last checkpoint (placement is asked again on wake).
  return { onPower, awake: true, cpuPct, memPct };
}

import os_ from "node:os";
import { execFileSync } from "node:child_process";
const nodeOs = () => os_;
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 });
