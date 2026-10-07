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

import { placeWorkload, nodeBlock, DEFAULT_LEND } from "../../kernel/placement/index.js";

/**
 * @typedef {{ onPower: boolean, awake: boolean, cpuPct: number, memPct: number }} DeviceState
 * @typedef {{ onlyOnPower?: boolean, onlyAwake?: boolean, cpuMaxPct?: number, memMaxPct?: number }} DeviceLimits
 * @typedef {{ where: "here"|"server"|"wait", reason: string }} Placement
 */

export const DEFAULT_LIMITS = DEFAULT_LEND;

// The decision is the scheduler's (kernel/placement): this file only turns the runner's facts into node records and the answer back into here, server or wait.
const HERE = "this-computer", SERVER = "space-server";
const stub = (/** @type {string} */ id, /** @type {"device"|"server"} */ kind, /** @type {any} */ lend = {}) => ({ id, name: id, kind, capabilities: ["compute"], resources: {}, residency: [], posture: {}, lend, key: "local" });

/** This computer as a node fact: its descriptor from the device's limits, its live state, and the two grants. */
const hereNode = (/** @type {any} */ o) => ({
  descriptor: stub(HERE, "device", { ...DEFAULT_LEND, ...(o.limits || {}) }),
  status: { online: true, awake: o.state.awake, onPower: o.state.onPower, cpuPct: o.state.cpuPct, memPct: o.state.memPct },
  consent: { spaceAllows: Boolean(o.spaceAllows), nodeHosts: Boolean(o.memberAccepts) },
  notReady: o.runnerReady || undefined,
});

/**
 * Why this computer cannot take the session now, or "" when it can.
 * @param {{ spaceAllows: boolean, memberAccepts: boolean, state: DeviceState, limits?: DeviceLimits, runnerReady?: string }} o
 */
export function hereBlock(o) {
  return nodeBlock(hereNode(o), {}, { space: "" })?.reason || "";
}

/**
 * @param {{ pinnedToServer?: boolean, spaceAllows: boolean, memberAccepts: boolean, state: DeviceState, limits?: DeviceLimits,
 *   runnerReady?: string, server?: { available: boolean, hasRoom: boolean, why?: string } }} o
 * @returns {Placement}
 */
export function place(o) {
  const here = hereNode(o);
  const s = o.server;
  /** @type {any[]} */ const nodes = [here];
  if (s) nodes.push({ descriptor: stub(SERVER, "server"), status: { online: s.available, why: s.why }, full: !s.hasRoom, consent: { spaceAllows: true, nodeHosts: true } });
  const r = placeWorkload({ space: "", requireSigned: false, nodes, workload: { at: HERE, pinnedTo: o.pinnedToServer ? "server" : undefined } });
  const block = (/** @type {string} */ id) => r.reasons.find(x => x.node === id)?.reason || "";
  if (r.placed && r.node === HERE) return { where: "here", reason: "this computer is allowed, awake and has room" };
  const why = block(HERE);
  if (r.placed) return { where: "server", reason: `on the space's server, because ${why}` };
  const sWhy = !s ? "the space has no server" : block(SERVER);
  return { where: "wait", reason: `waiting: ${why}, and ${sWhy}` };
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
