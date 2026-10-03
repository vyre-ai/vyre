// kernel/core/idem.js: idempotency keys for effects (record writes, task requests). The runner keys every effect; a repeated key returns the first result and
// does the act once, so a retried or replayed step never writes twice. The key is scoped to the acting actor and the operation; the same key with different
// input is a conflict, never a quiet second write. A failure frees the key (the retry may run); a success keeps it for a day. In memory: a restart forgets keys,
// and a replayed step after a restart is then decided by the record's own version check (`version_conflict`), not by this.
import { canonical, sha256 } from "./canonical.js";
import { KernelError } from "./errors.js";

const TTL_MS = 24 * 3600 * 1000;

/** @param {{ clock?: () => number }} [cfg] */
export function createIdem(cfg = {}) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, { hash: string, at: number, p: Promise<any> }>} */ const seen = new Map();
  return Object.freeze({
    /**
     * @param {any} chain @param {string} op @param {string | undefined} key @param {any} input @param {() => Promise<any>} run
     */
    async once(chain, op, key, input, run) {
      if (key === undefined || key === null) return run();
      if (typeof key !== "string" || !key || key.length > 200) throw new KernelError("bad_input", "an idempotency key is a short text");
      const a = chain.hops[chain.hops.length - 1].actor;
      const k = `${a.kind}:${a.id}|${op}|${key}`, hash = sha256(canonical(input ?? null)), now = clock();
      for (const [kk, v] of seen) if (now - v.at > TTL_MS) seen.delete(kk);
      const had = seen.get(k);
      if (had) {
        if (had.hash !== hash) throw new KernelError("idem_conflict", "that key was used for different input");
        return had.p;
      }
      const p = run();
      seen.set(k, { hash, at: now, p });
      try { return await p; } catch (e) { seen.delete(k); throw e; }
    },
  });
}
