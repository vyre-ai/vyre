// @ts-check
// The idle CPU budget of scripts/perf-check on a shared runner. vyred's CPU is already read as its own CPU time (utime + stime from /proc), but one idle window on a loaded host still wobbles: a
// neighbour's burst stretches the same work. A real idle cost shows in every window and a wobble shows in one, so the check takes a second window when the first is over budget and judges the
// better of the two. Both numbers are printed.

/** @param {number[]} xs @param {number} p */
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}
const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** The highest mean over any `window` consecutive samples (sustained load, not one spike); the mean of all when there are fewer. @param {number[]} xs @param {number} window */
export function maxWindowMean(xs, window) {
  if (xs.length <= window) return mean(xs);
  let best = 0;
  for (let i = 0; i + window <= xs.length; i++) best = Math.max(best, mean(xs.slice(i, i + window)));
  return best;
}

/** @param {number[]} cpu per-sample CPU% @param {{ cpuPct: number, cpuSustainedPct: number, cpuSustainedWindow: number }} budget */
export function cpuStats(cpu, budget) {
  const p95 = percentile(cpu, 95), sustained = maxWindowMean(cpu, budget.cpuSustainedWindow);
  return { p95, sustained, over: p95 >= budget.cpuPct || sustained >= budget.cpuSustainedPct };
}

/**
 * Which window the CPU budget is judged on: the first when it is within budget, else the one with the lower sustained load (the first on a tie).
 * @param {number[]} first @param {number[] | null} second @param {Parameters<typeof cpuStats>[1]} budget @returns {{ chosen: "first" | "second", first: ReturnType<typeof cpuStats>, second: ReturnType<typeof cpuStats> | null }}
 */
export function pickWindow(first, second, budget) {
  const a = cpuStats(first, budget), b = second ? cpuStats(second, budget) : null;
  if (!a.over || !b) return { chosen: "first", first: a, second: b };
  return { chosen: b.sustained < a.sustained ? "second" : "first", first: a, second: b };
}
