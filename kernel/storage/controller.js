// kernel/storage/controller.js: Vyre's own controller for a pool. It is the only thing that heals and drains, on a timer no faster than 60 s (SPEC
// principle 8): probe every node, heal when anything changed or something is short of copies, drain when an offer is withdrawn, and say what happened in
// one plain event. Nothing here knows an engine: SeaweedFS replicates inside its own node (`copies`), and the pool counts it.
export const MIN_TICK_MS = 60_000;

/** @param {{ pool: import("./pool.js").Pool, tickMs?: number, emit?: (e: any) => void, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval }} o */
export const BACKUP_EVERY_MS = 3_600_000, BACKUP_DIRTY_BYTES = 32 * 1024 * 1024;

export function createController({ pool, tickMs = MIN_TICK_MS, emit = () => {}, setTimer = setInterval, clearTimer = clearInterval, backup = null, backupEveryMs = BACKUP_EVERY_MS, dirtyBytes = BACKUP_DIRTY_BYTES }) {
  let timer = null, busy = null;
  const run = async () => {
    const changed = await pool.probe(); const sc = await pool.scrub({ limit: 5 });
    const r = changed.length || sc.dropped || pool.report().nudges.some(n => /fewer copies/.test(n)) ? await pool.heal() : { copied: 0, atRisk: 0, unreachable: 0 };
    // The index backup (indexbackup.js): hourly, and sooner after a large change. `backup()` writes it and returns the head, which the kernel records where the owner's devices hold checkpoints.
    if (backup && (pool.dirty >= dirtyBytes || (pool.dirty > 0 && pool.now() - (pool.ix.index_at ?? 0) >= backupEveryMs))) { try { const h = await backup(); emit({ type: "storage.index", seq: h.seq, hash: h.hash, copies: h.copies, at_risk: h.atRisk }); } catch { /* tried again next tick */ } }
    const rep = pool.report();
    if (sc.dropped) emit({ type: "storage.scrub", dropped: sc.dropped, checked: sc.checked });
    if (changed.length || r.copied) emit({ type: "storage.tick", changed, copied: r.copied, at_risk: r.atRisk, unreachable: r.unreachable, nudges: rep.nudges });
    return { changed, ...r };
  };
  const once = () => (busy ??= run().finally(() => { busy = null; }));
  return {
    tick: once,
    start() { if (!timer) { timer = setTimer(() => { once().catch(() => {}); }, Math.max(tickMs, MIN_TICK_MS)); timer.unref?.(); } },
    stop() { if (timer) clearTimer(timer); timer = null; },
    /** The owner withdrew a node's offer: copy everything off, then release it. The card says how long it will take from `bytes`. */
    async withdraw(id) {
      const mine = Object.values(pool.ix.chunks).filter(c => c.nodes.includes(id)).reduce((a, c) => a + c.size, 0);
      emit({ type: "storage.draining", node: id, bytes: mine });
      const r = await pool.drain(id); emit({ type: "storage.released", node: id, moved: r.moved }); return r;
    },
  };
}
