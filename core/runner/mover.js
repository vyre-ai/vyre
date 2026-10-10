// @ts-check
// The mover (R031-95 2.4): when a session on this computer should go to the server, and why. It reads this computer's conditions and the person's limits and says which sessions to hand over, with the reason
// the chat will print. It moves nothing itself: the runner module hands each one over (freeze, last checkpoint, release) and the server records the move. Pure over its inputs and a clock, so a test feeds it
// a lid, a battery and a minute of load without a Mac.
//
// One move per state change: a condition that holds for every session (switched off, asleep, on battery) moves all of them once; a cap that is passed for a sustained minute moves the heaviest session and
// starts the minute again, so the next one waits for another minute over the limit. Whether a session moved for a condition may be moved again is the server's cooldown (placement-book.js), not this file's.
import { execFileSync } from "node:child_process";

/** How long a limit must be passed, without a break, before a session moves for it. A spike is not a reason. */
export const SUSTAIN_MS = 60_000;

/**
 * @param {{ now?: () => number, sustainMs?: number }} [o]
 */
export function createMover(o = {}) {
  const now = o.now || Date.now, sustain = o.sustainMs ?? SUSTAIN_MS;
  /** @type {number | null} */ let cpuSince = null;
  /** @type {number | null} */ let memSince = null;
  return {
    /**
     * @param {{ settings: { enabled: boolean, pluggedInOnly: boolean, cpuPercent: number, memoryMb: number }, sleeping?: "lid-closed" | "asleep" | null, onPower: boolean, sessions: { session: string, cpuPercent: number, memoryMb: number }[] }} i
     * @returns {{ session: string, reason: string }[]} the sessions to hand over now
     */
    tick({ settings, sleeping, onPower, sessions }) {
      if (!sessions.length) { cpuSince = memSince = null; return []; }
      const all = !settings.enabled ? "switched-off" : sleeping ? sleeping : settings.pluggedInOnly && !onPower ? "unplugged" : null;
      if (all) { cpuSince = memSince = null; return sessions.map(s => ({ session: s.session, reason: all })); }
      const t = now();
      const cpu = sessions.reduce((n, s) => n + (s.cpuPercent || 0), 0), mem = sessions.reduce((n, s) => n + (s.memoryMb || 0), 0);
      cpuSince = cpu > settings.cpuPercent ? (cpuSince ?? t) : null;
      memSince = mem > settings.memoryMb ? (memSince ?? t) : null;
      const heaviest = (/** @type {"cpuPercent" | "memoryMb"} */ k) => sessions.reduce((a, b) => ((b[k] || 0) > (a[k] || 0) ? b : a));
      if (cpuSince !== null && t - cpuSince >= sustain) { cpuSince = null; return [{ session: heaviest("cpuPercent").session, reason: "cpu-cap" }]; }
      if (memSince !== null && t - memSince >= sustain) { memSince = null; return [{ session: heaviest("memoryMb").session, reason: "mem-cap" }]; }
      return [];
    },
    reset() { cpuSince = memSince = null; },
  };
}

/**
 * Why this Mac is going to sleep: its lid is closed, or something else (idle, the person, a low battery). A Mac reports the lid in the clamshell state of its power domain; anything we cannot read is plain sleep.
 * @param {{ platform?: string, run?: (cmd: string, args: string[]) => string }} [o] @returns {"lid-closed" | "asleep"}
 */
export function sleepReason(o = {}) {
  if ((o.platform || process.platform) !== "darwin") return "asleep";
  const run = o.run || ((/** @type {string} */ c, /** @type {string[]} */ a) => execFileSync(c, a, { encoding: "utf8", timeout: 2000 }));
  try { return /"AppleClamshellState"\s*=\s*Yes/.test(run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"])) ? "lid-closed" : "asleep"; } catch { return "asleep"; }
}
