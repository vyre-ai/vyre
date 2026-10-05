// @ts-check
// grants: where storage grants are written: this module's own small table, with the contract's fields (kernel/contracts/grant.d.ts). They are never handed to the kernel: `storage.hold` is
// not a kernel action (the kernel refuses a grant for an action it does not know, and wants a chain it built), and what lets a storage device hold chunks is the pool's own credential, not a kernel grant.

import { checkGrantInput, timeId } from "../grants.js";

export const GRANT_MIGRATIONS = [
  `CREATE TABLE wink_storage_grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)`,
];

/** @param {{ ctx: any, space: () => string, now?: () => number }} o */
export function storageGrants({ ctx, space, now = Date.now }) {
  const db = ctx.store.db;
  const row = (/** @type {any} */ r) => (r ? JSON.parse(r.body) : null);
  return {
    /** @param {any} input @param {any} issuer */
    async create(input, issuer) {
      checkGrantInput(input);
      const t = now();
      const g = { id: timeId("gr_", t), space: space(), subject: input.subject, actions: [...input.actions], action_set_version: 1, resource: input.resource, conditions: input.conditions || {}, issuer, source: input.source, status: "active", created_at: t, ...(input.reason ? { reason: input.reason } : {}) };
      db.prepare("INSERT INTO wink_storage_grants (id, status, body) VALUES (?, 'active', ?)").run(g.id, JSON.stringify(g));
      ctx.events.emit("grant.created", { grant: g });
      return g;
    },
    /** @param {string} id @param {string} reason */
    async revoke(id, reason) {
      const g = row(db.prepare("SELECT body FROM wink_storage_grants WHERE id = ?").get(String(id)));
      if (!g) throw Object.assign(new Error("no such grant"), { code: "not_found" });
      if (g.status === "revoked") return g;
      const out = { ...g, status: "revoked", revoked_at: now(), reason: String(reason || "").slice(0, 200) };
      db.prepare("UPDATE wink_storage_grants SET status = 'revoked', body = ? WHERE id = ?").run(JSON.stringify(out), g.id);
      ctx.events.emit("grant.revoked", { grant: out });
      return out;
    },
    /** @param {string} id */
    async get(id) {
      return row(db.prepare("SELECT body FROM wink_storage_grants WHERE id = ?").get(String(id))) || null;
    },
  };
}
