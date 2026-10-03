// @ts-check
// The adapter between wink storage devices and the vault team's pool engine (origin/work/sealing: kernel/storage/pool.js, backends.js).
//
// The engine is a library: a `Pool` holds nodes (a node is a backend: put, get, del, ping) and places encrypted chunks on them. This file is the only
// place that connects the two, through the seam documented in storage/index.js and docs/work/tailnet.md:
//   poolOffers()      -> a node is added to the pool for every live offer (once)
//   getCredentials()  -> the backend for it is built from the access details; they pass through this function and nowhere else
//   setUsed()         -> what the pool says each node holds is written back to the offer
//   drainRequests()   -> a device a person asked to remove: pool.drain(id) copies everything off, then completeDrain(id) lets it go
// PORT: until the pool engine is merged into this tree, `pool` and `makeBackend` are passed in (tests pass the engine's own shapes; a box passes
// `new Pool(...)` and `(c) => s3Backend(...) | dirBackend(...)` from kernel/storage/backends.js). Nothing here imports the engine, so no boundary edge
// is added. Nothing here puts an access detail on an event, in a log line or in a returned value.

/** What a device kind is to the pool. */
export const POOL_KIND = Object.freeze({ s3: "s3", volume: "cloud_volume", smb: "network_drive", nfs: "network_drive", afp: "network_drive", "usb-disk": "usb_disk" });

/**
 * @typedef {{ nodes: Map<string, any>, addNode(n: any): any, used(id: string): number, drain(id: string): Promise<{ moved: number }>, forget?(id: string): void }} PoolLike
 * @param {{ storage: any, pool: PoolLike | (() => PoolLike | null | Promise<PoolLike | null>), by: () => Promise<{ kind: string, id: string }> | { kind: string, id: string },
 *   makeBackend: (c: { kind: string, location: any, accessKey?: string, secretKey?: string }, offer: any) => any, log?: (m: string) => void, now?: () => number }} o
 */
export function attachPool(o) {
  const log = o.log || (() => {});
  /** The last answer for a drain that could not finish yet, so it is tried again later and said once. @type {Map<string, string>} */
  const blocked = new Map();
  const poolOf = async () => (typeof o.pool === "function" ? o.pool() : o.pool);

  /** One pass. Idempotent: run it after a pairing, a removal and on the slow timer. */
  async function sync() {
    const pool = await poolOf();
    const out = { added: /** @type {string[]} */ ([]), drained: /** @type {string[]} */ ([]), blocked: /** @type {{ id: string, code: string }[]} */ ([]), forgotten: /** @type {string[]} */ ([]), skipped: /** @type {{ id: string, why: string }[]} */ ([]) };
    if (!pool) return out;
    const by = await o.by();
    const offers = /** @type {any[]} */ (o.storage.poolOffers());
    const live = new Set(offers.map(x => x.id));

    for (const off of offers) {
      if (off.drain || off.state === "expired" || off.state === "removed" || pool.nodes.has(off.id)) continue;
      try {
        const c = off.credentialRef ? await o.storage.getCredentials(off.credentialRef, { by }) : { kind: off.kind, location: off.location };
        const backend = o.makeBackend(c, off);
        if (!backend) { out.skipped.push({ id: off.id, why: "no backend for this kind" }); continue; }
        pool.addNode({ id: off.id, backend, kind: POOL_KIND[/** @type {"s3"} */ (off.kind)] || "server", home: false, site: off.id, owned: off.kind !== "s3", offered: off.storage.capacity });
        out.added.push(off.id);
      } catch (e) { out.skipped.push({ id: off.id, why: String((/** @type {any} */ (e)).code || "failed") }); log(`wink storage: could not add ${off.id} to the pool (${(/** @type {any} */ (e)).code || "failed"})`); }
    }

    for (const id of [...pool.nodes.keys()]) {
      if (live.has(id)) { try { o.storage.setUsed(id, pool.used(id)); } catch { /* removed meanwhile */ } }
      else if (typeof pool.forget === "function" && !(pool.nodes.get(id) || {}).home) { pool.forget(id); out.forgotten.push(id); }
    }

    for (const req of /** @type {any[]} */ (o.storage.drainRequests())) {
      try {
        if (pool.nodes.has(req.id)) await pool.drain(req.id);
        await o.storage.completeDrain(req.id);
        blocked.delete(req.id);
        out.drained.push(req.id);
      } catch (e) {
        const code = String((/** @type {any} */ (e)).code || "failed");
        out.blocked.push({ id: req.id, code });
        if (blocked.get(req.id) !== code) { blocked.set(req.id, code); log(`wink storage: draining ${req.id} is waiting (${code})`); }
      }
    }
    return out;
  }
  return { sync };
}
