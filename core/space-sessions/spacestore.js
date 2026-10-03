// core/space-sessions/spacestore.js: the Space's side of a session: file versions per path, checkpoints and the lease with its fencing token.
// An in-memory reference implementation of the transport the working copy talks to. The real one sits over the Space's Drive and records.
import { sha256 } from "../../kernel/core/canonical.js";

export function createSpaceStore(/** @type {{ clock?: () => number }} */ o = {}) {
  const clock = o.clock || Date.now;
  /** @type {Map<string, Map<string, { version: number, hash: string, bytes: Buffer, by: string }>>} */ const files = new Map();
  /** @type {Map<string, any[]>} */ const cps = new Map();
  /** @type {Map<string, { device: string, token: number, expires: number } | null>} */ const leases = new Map();
  /** @type {Map<string, number>} */ const tokens = new Map();
  const fs_ = (/** @type {string} */ s) => { let m = files.get(s); if (!m) { m = new Map(); files.set(s, m); } return m; };
  const key = (/** @type {string} */ space, /** @type {string} */ session) => `${space}\0${session}`;

  return Object.freeze({
    /** Push one path. A write based on an older version than the Space holds is a conflict: the Space's version stays, the caller keeps its own as a sibling. */
    async push(/** @type {{ space: string, session: string, path: string, base_version: number, bytes: Buffer, device: string, token?: number }} */ r) {
      const lease = leases.get(key(r.space, r.session));
      if (lease && r.token !== undefined && r.token !== lease.token) return { ok: false, stale_lease: true };
      const m = fs_(key(r.space, r.session));
      const cur = m.get(r.path);
      if (cur && cur.version !== r.base_version) return { ok: false, conflict: { version: cur.version, hash: cur.hash } };
      if (!cur && r.base_version !== 0) return { ok: false, conflict: { version: 0, hash: "" } };
      const version = (cur ? cur.version : 0) + 1;
      m.set(r.path, { version, hash: sha256(r.bytes), bytes: Buffer.from(r.bytes), by: r.device });
      return { ok: true, version };
    },
    async remove(/** @type {{ space: string, session: string, path: string, base_version: number }} */ r) {
      const m = fs_(key(r.space, r.session)); const cur = m.get(r.path);
      if (!cur) return { ok: true };
      if (cur.version !== r.base_version) return { ok: false, conflict: { version: cur.version, hash: cur.hash } };
      m.delete(r.path); return { ok: true };
    },
    async pull(/** @type {{ space: string, session: string, path: string }} */ r) { const c = fs_(key(r.space, r.session)).get(r.path); return c ? { version: c.version, hash: c.hash, bytes: Buffer.from(c.bytes) } : null; },
    async manifest(/** @type {{ space: string, session: string }} */ r) { return [...fs_(key(r.space, r.session))].map(([path, v]) => ({ path, version: v.version, hash: v.hash })).sort((a, b) => (a.path < b.path ? -1 : 1)); },

    // lease with a fencing token: two machines are never both active. A new holder gets a higher token, and every write carries it.
    async acquire(/** @type {{ space: string, session: string, device: string, ttl_ms: number }} */ r) {
      const k = key(r.space, r.session), cur = leases.get(k), now = clock();
      if (cur && cur.expires > now && cur.device !== r.device) return { ok: false, held_by: cur.device };
      const token = cur && cur.device === r.device && cur.expires > now ? cur.token : (tokens.get(k) || 0) + 1;
      tokens.set(k, token);
      leases.set(k, { device: r.device, token, expires: now + r.ttl_ms });
      return { ok: true, token };
    },
    async renew(/** @type {{ space: string, session: string, device: string, token: number, ttl_ms: number }} */ r) {
      const k = key(r.space, r.session), cur = leases.get(k);
      if (!cur || cur.device !== r.device || cur.token !== r.token || cur.expires <= clock()) return { ok: false };
      cur.expires = clock() + r.ttl_ms; return { ok: true };
    },
    async release(/** @type {{ space: string, session: string, device: string, token: number }} */ r) {
      const k = key(r.space, r.session), cur = leases.get(k);
      if (cur && cur.device === r.device && cur.token === r.token) { leases.set(k, null); return { ok: true }; }
      return { ok: false };
    },
    async writeCheckpoint(/** @type {{ space: string, session: string, token: number, checkpoint: any }} */ r) {
      const k = key(r.space, r.session), cur = leases.get(k);
      if (!cur || cur.token !== r.token || cur.expires <= clock()) return { ok: false, stale_lease: true };
      const list = cps.get(k) || []; const seq = list.length + 1;
      list.push({ ...r.checkpoint, seq, at: clock() }); cps.set(k, list);
      return { ok: true, seq };
    },
    async checkpoints(/** @type {{ space: string, session: string }} */ r) { return (cps.get(key(r.space, r.session)) || []).map(c => ({ ...c })); },
  });
}
