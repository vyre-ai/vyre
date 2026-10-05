// @ts-check
// grants: where storage grants are written. With the kernel wired in (`ctx.kernel.grants`) they go to the kernel; until then they live in this
// module's own small table with the contract's fields (kernel/contracts/grant.d.ts), exactly as core/wink/grants.js does for the Wink module.

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
      if (ctx.kernel && ctx.kernel.grants) return ctx.kernel.grants.create(issuer, input);
      const t = now();
      const g = { id: timeId("gr_", t), space: space(), subject: input.subject, actions: [...input.actions], action_set_version: 1, resource: input.resource, conditions: input.conditions || {}, issuer, source: input.source, status: "active", created_at: t, ...(input.reason ? { reason: input.reason } : {}) };
      db.prepare("INSERT INTO wink_storage_grants (id, status, body) VALUES (?, 'active', ?)").run(g.id, JSON.stringify(g));
      ctx.events.emit("grant.created", { grant: g });
      return g;
    },
    /** @param {string} id @param {string} reason */
    async revoke(id, reason) {
      if (ctx.kernel && ctx.kernel.grants) return ctx.kernel.grants.revoke(id, reason);
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
      if (ctx.kernel && ctx.kernel.grants && ctx.kernel.grants.get) return ctx.kernel.grants.get(id);
      return row(db.prepare("SELECT body FROM wink_storage_grants WHERE id = ?").get(String(id))) || null;
    },
  };
}
