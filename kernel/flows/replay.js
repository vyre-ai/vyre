// @ts-check
// kernel/flows/replay: "try it on last week" (R032-10). A practice run (runner.simulate) replays the real triggers of a window through a version of a Flow with every action stubbed. This file sets that
// beside what the Flow really did in the same window, trigger by trigger, and says in a line what would be different. Pure.

/**
 * The steps a real run got through, by id (a loop's turns are one step). The steps its parallel lanes ran count as the run's own: a practice run walks the lanes in place.
 * @param {any} run @param {any[]} [all] every run of the Flow, to find the lanes @returns {string[]}
 */
export function stepsDone(run, all = []) {
  /** @type {Set<string>} */ const out = new Set();
  const take = (/** @type {any} */ r, /** @type {number} */ depth) => {
    for (const [k, v] of Object.entries(r.steps || {})) {
      if (k.includes("?") || k.includes("!") || !v) continue;
      const e = /** @type {any} */ (v);
      if (e.status === "done") out.add(k.replace(/@.*$/, ""));
      if (depth < 4) for (const id of e.children || []) { const kid = all.find(x => x.id === id); if (kid && kid.parent && kid.parent.lane) take(kid, depth + 1); }
    }
  };
  take(run, 0);
  return [...out].sort();
}

/** The trigger a run answered, as one comparable key: the event's id, else the time. @param {any} trigger */
const keyOf = trigger => (trigger && trigger.event && trigger.event.id !== undefined ? `event:${trigger.event.id}` : trigger && trigger.at !== undefined ? `at:${trigger.at}` : null);

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Compare a practice run's `runs` with the real runs of a Flow in the same window.
 * @param {{ runs: { event: any, at?: number, ran: string[], outcome: string }[], matched: number }} sim the result of runner.simulate
 * @param {any[]} real the Flow's real runs @param {{ since?: number, until?: number }} window
 */
export function compareHistory(sim, real, window) {
  const inWindow = real.filter(r => !r.dry && !r.parent && (window.since === undefined || r.started_at >= window.since) && (window.until === undefined || r.started_at <= window.until));
  /** @type {Map<string, any>} */ const then = new Map();
  for (const r of inWindow) { const k = keyOf(r.trigger); if (k) then.set(k, r); }
  let same = 0;
  /** @type {{ trigger: string, was: string[], now: string[], why: string }[]} */ const differ = [];
  let fresh = 0;
  for (const s of sim.runs) {
    const k = s.event !== null && s.event !== undefined ? `event:${s.event}` : s.at !== undefined ? `at:${s.at}` : null;
    const r = k ? then.get(k) : null;
    if (!r) { fresh++; continue; }
    then.delete(/** @type {string} */ (k));
    const was = stepsDone(r, real), now = [...s.ran].sort();
    const finished = r.state === "done" || r.state === "failed" || r.state === "cancelled";
    // a run still waiting for a person has done part of what the practice run did: that is the same so far
    const ok = finished ? was.length === now.length && was.every((x, i) => x === now[i]) : was.every(x => now.includes(x));
    if (ok) same++;
    else differ.push({ trigger: /** @type {string} */ (k), was, now, why: `it did ${was.join(", ") || "nothing"}; this version would do ${now.join(", ") || "nothing"}` });
  }
  const dropped = then.size;
  const line = `In that time it really ran ${count(inWindow.length, "time", "times")}. This version would run ${count(sim.runs.length, "time", "times")}: ${same} the same, ${differ.length} different, ${fresh} new, ${dropped} it would not run.`;
  return { ran: inWindow.length, would: sim.runs.length, same, differ: differ.slice(0, 20), new: fresh, dropped, matches: differ.length === 0 && fresh === 0 && dropped === 0, line };
}
