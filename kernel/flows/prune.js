// @ts-check
// kernel/flows/prune: old finished runs shrink to one line (setting flows.runs_keep_days, default 90). A run is a record with its whole ledger in it; after the Space's chosen number of days a finished run
// keeps only what a timeline and a list need: the Flow, the record it was about, how it ended and when. Never deleted outright: the row stays, the event log stays the audit trail. A run that is
// still going, one waiting for a person, and one that failed and still needs a person are never touched; neither is a run with a lane or a sub-flow still going.

export const KEEP_DAYS = 90;
const OUTCOME = { done: "done", failed: "did not finish", cancelled: "stopped" };

/** Can this run shrink? Finished, nothing waiting on it, and not a failure a person still has to deal with. @param {any} run */
export function prunable(run) {
  if (!run || run.pruned) return false;
  if (run.state === "done" || run.state === "cancelled") return true;
  return run.state === "failed" && !run.attention;
}

/** The one-line form of a run: the same row (so lists, the timeline and counts still read it), with the ledger gone. @param {any} run */
export function summaryOf(run) {
  const label = String(run.label || run.flow || "A Flow").slice(0, 120);
  const outcome = /** @type {Record<string, string>} */ (OUTCOME)[run.state] || String(run.state);
  return {
    id: run.id, flow: run.flow, version: run.version, hash: run.hash, space: run.space, approver: run.approver, state: run.state, depth: run.depth || 0,
    started_at: run.started_at, updated_at: run.finished_at ?? run.updated_at, finished_at: run.finished_at, tainted: Boolean(run.tainted),
    ...(run.label ? { label: run.label } : {}), ...(run.record ? { record: run.record } : {}), ...(run.parent ? { parent: run.parent } : {}),
    ...(run.state === "failed" && run.error ? { error: { code: String(run.error.code || "error"), message: String(run.error.message || "").slice(0, 200) } } : {}),
    trigger: { kind: run.trigger && run.trigger.kind }, steps: {}, pruned: true, summary: `${label}: ${outcome}`,
  };
}

/**
 * @param {{ store: any, now: () => number, locked: (id: string, fn: () => Promise<any>) => Promise<any> }} h
 */
export function createPruner(h) {
  /** The ids of the runs a run started (lanes and sub-flows), whatever depth. @param {any} run @param {Set<string>} [seen] @returns {string[]} */
  const kidsOf = (run, seen = new Set()) => {
    for (const l of Object.values(run.steps || {})) for (const id of ((/** @type {any} */ (l)).children || [])) if (!seen.has(id)) seen.add(id);
    return [...seen];
  };

  /**
   * Shrink the finished runs that started more than `keepMs` ago. At most `limit` a pass, oldest first, so a long backlog clears over a few passes.
   * @param {number} keepMs @param {number} [limit] @returns {Promise<number>} how many runs shrank
   */
  async function sweep(keepMs, limit = 200) {
    const cutoff = h.now() - keepMs;
    const old = (await h.store.listRuns({ before: cutoff, limit: 1000 })).filter((/** @type {any} */ r) => !r.parent && prunable(r)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.started_at - b.started_at).slice(0, limit);
    let n = 0;
    for (const root of old) {
      const kids = (await Promise.all(kidsOf(root).map(id => h.store.getRun(id)))).filter(Boolean);
      // a lane or a sub-flow still going keeps its parent whole
      if (kids.some(k => k.state === "running" || k.state === "waiting" || k.state === "queued" || k.state === "paused" || (k.state === "failed" && k.attention))) continue;
      for (const r of [root, ...kids]) {
        n += await h.locked(r.id, async () => {
          const cur = await h.store.getRun(r.id);
          if (!cur || !prunable(cur)) return 0;
          await h.store.putRun(summaryOf(cur));
          return 1;
        });
      }
    }
    return n;
  }
  return { sweep };
}
