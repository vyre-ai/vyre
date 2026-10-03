// core/space-sessions/checkpoint.js: a checkpoint at every turn, and a lease so a session is active on one machine at a time.
// The checkpoint is what another machine needs to carry on: the transcript delta, the working copy's manifest hash, the task state and the
// session's meta. Every write carries the lease's fencing token, so a machine that lost the lease cannot write over the one that has it.
import { sha256, canonical } from "../../kernel/core/canonical.js";

const LEASE_MS = 120_000;

/** @param {{ space: string, store: any, workcopy?: any }} cfg */
export function createRunner(cfg) {
  return Object.freeze({
    /** @param {{ session: string, device: string }} q */
    async activate(q) {
      const r = await cfg.store.acquire({ space: cfg.space, session: q.session, device: q.device, ttl_ms: LEASE_MS });
      if (!r.ok) throw Object.assign(new Error(`this session is active on another machine (${r.held_by})`), { code: "lease_held", held_by: r.held_by });
      return { token: r.token, renew: () => cfg.store.renew({ space: cfg.space, session: q.session, device: q.device, token: r.token, ttl_ms: LEASE_MS }), release: () => cfg.store.release({ space: cfg.space, session: q.session, device: q.device, token: r.token }) };
    },
    /** After a turn: push the files, then write the checkpoint. @param {{ session: string, token: number, workcopy: any, transcript_delta: any[], tasks?: any, meta?: any }} t */
    async turnDone(t) {
      const manifest_hash = await t.workcopy.manifestHash();
      const prior = await cfg.store.checkpoints({ space: cfg.space, session: t.session });
      const checkpoint = { transcript_delta: t.transcript_delta, transcript_hash: sha256(canonical(t.transcript_delta)), manifest_hash, tasks: t.tasks || [], meta: t.meta || {}, turn: prior.length + 1 };
      const r = await cfg.store.writeCheckpoint({ space: cfg.space, session: t.session, token: t.token, checkpoint });
      if (!r.ok) throw Object.assign(new Error("another machine holds this session now"), { code: "stale_lease" });
      return { seq: r.seq, manifest_hash };
    },
    /** Rebuild on this machine from the latest checkpoint. The caller opens the working copy with the same session key and passes it here. @param {{ session: string, device: string, workcopy: any }} q */
    async resume(q) {
      const lease = await this.activate({ session: q.session, device: q.device });
      try {
        const cps = await cfg.store.checkpoints({ space: cfg.space, session: q.session });
        if (!cps.length) throw Object.assign(new Error("no checkpoint to resume from"), { code: "not_found" });
        for (const c of cps) if (sha256(canonical(c.transcript_delta)) !== c.transcript_hash) throw Object.assign(new Error("a checkpoint does not match its hash"), { code: "integrity" });
        const last = cps[cps.length - 1];
        await q.workcopy.hydrate();
        const now = await q.workcopy.manifestHash();
        if (now !== last.manifest_hash) throw Object.assign(new Error("the files do not match the last checkpoint"), { code: "integrity" });
        return { lease, transcript: cps.flatMap(c => c.transcript_delta), tasks: last.tasks, meta: last.meta, turn: last.turn };
      } catch (e) { await lease.release(); throw e; }
    },
  });
}
