// @ts-check
// The workspace key lease (DESIGN-local-runner section 3).
//
// The key that opens a space's encrypted workspace on this computer is leased from the space's vault for an hour
// and renewed while access holds. It lives in memory only (a Buffer, zeroed on lock). No lease, no open workspace.
//
//   - expiry (the lease ran out, or renewal kept failing): lock. The workspace is closed and unreadable; the data stays.
//   - revoke (the vault says access ended, or the member or space removed a grant): lock and delete the workspace.
//
// A machine that is offline when access ends keeps a locked, unreadable workspace: nobody can open it without a key
// the vault will never issue again, and the next contact deletes it. A machine that was open at the moment of
// removal can read until its lease ends (at most one hour). Those are the honest limits.
//
// vault.lease({ space, device }) -> { id, key (base64), ttlMs } | { revoked: true }
// vault.renew({ id })            -> { ttlMs } | { revoked: true }   (a thrown error is a transient failure)

export const DEFAULT_TTL_MS = 60 * 60_000;

/**
 * @param {{ vault: { lease(o: any): Promise<any>, renew(o: any): Promise<any> }, space: string, device: string,
 *   onLock?: (why: "expired"|"released"|"revoked") => Promise<void>|void, onRevoke?: () => Promise<void>|void,
 *   now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, retryMs?: number }} o
 */
export function createLease(o) {
  const now = o.now || Date.now, set = o.setTimer || setTimeout, clear = o.clearTimer || clearTimeout;
  const retry = o.retryMs ?? 30_000;
  /** @type {Buffer|null} */ let key = null;
  let id = "", expiresAt = 0, timer = null, expiry = null, state = "none", ttl = DEFAULT_TTL_MS;

  const stopTimers = () => { if (timer) clear(timer); if (expiry) clear(expiry); timer = expiry = null; };
  const zero = () => { if (key) { key.fill(0); key = null; } };

  async function end(why) {
    stopTimers();
    zero();
    state = why === "revoked" ? "revoked" : "locked";
    try { await o.onLock?.(why); } catch {}
    if (why === "revoked") { try { await o.onRevoke?.(); } catch {} }
  }

  function arm(ttlMs) {
    ttl = ttlMs;
    expiresAt = now() + ttlMs;
    stopTimers();
    // Renew at half the lease, so a failed renewal has the other half to retry.
    timer = set(renew, Math.max(1, Math.floor(ttlMs / 2)));
    expiry = set(() => { end("expired"); }, ttlMs);
    timer?.unref?.(); expiry?.unref?.();
  }

  async function renew() {
    if (state !== "open") return;
    try {
      const r = await o.vault.renew({ id });
      if (state !== "open") return;
      if (r && r.revoked) return end("revoked");
      arm(Number(r?.ttlMs) > 0 ? Number(r.ttlMs) : ttl);
    } catch {
      if (state !== "open") return;
      // Transient: try again soon, and let the expiry timer lock if it never comes back.
      timer = set(renew, Math.min(retry, Math.max(1, expiresAt - now() - 1)));
      timer?.unref?.();
    }
  }

  return {
    /** Ask the vault for the key. Resolves with { ok: true } or { ok: false, why }. */
    async acquire() {
      if (state === "open") return { ok: true };
      let r;
      try { r = await o.vault.lease({ space: o.space, device: o.device }); } catch (e) { return { ok: false, why: "the space could not be reached" }; }
      if (!r || r.revoked) { await end("revoked"); return { ok: false, why: "access to this space has ended" }; }
      zero();
      key = Buffer.from(String(r.key), "base64");
      id = String(r.id);
      state = "open";
      arm(Number(r.ttlMs) > 0 ? Number(r.ttlMs) : DEFAULT_TTL_MS);
      return { ok: true };
    },
    /** The key while the lease holds, else null. A copy is not made: callers write it straight to a pipe. */
    key() { return state === "open" && now() < expiresAt ? key : null; },
    get state() { return state; },
    get expiresAt() { return expiresAt; },
    /** Close the workspace now (the member stops using it); the key is zeroed and the data stays. */
    async release() { if (state === "open") await end("released"); },
    /** Access ended (a grant was removed, or the vault said so): lock and delete. */
    async revoke() { if (state !== "revoked") await end("revoked"); },
  };
}
