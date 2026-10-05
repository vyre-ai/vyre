// @ts-check
// grants: the grant table Wink writes, in the shape of the kernel contract (kernel/contracts/grant.d.ts, contract 6.2): a grant lives where
// the thing it protects lives, is never widened (a wider one is a new grant), and every create and revoke writes an event. When the kernel
// takes over device grants, they move to it; today the kernel's grants store takes chains and other actions (its `create(chain, input)`), not this module's `create(input, issuer)`, so these grants live in one table of this box's store with exactly the contract's fields, so nothing changes when the kernel arrives.

import crypto from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A time-prefixed id: 48 bits of the time in hex, then 12 random bytes. @param {string} prefix @param {number} t */
export const timeId = (prefix, t) => `${prefix}${t.toString(16).padStart(12, "0")}-${crypto.randomBytes(12).toString("hex")}`;
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
/** base32 (lowercase, no padding) of bytes, first n characters. @param {Uint8Array} b @param {number} n */
export function base32(b, n) {
  let bits = 0, v = 0, out = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, n);
}
/** `spc_` plus the first 12 base32 characters of the SHA-256 of the box's route id: a stand-in for the box key until the kernel mints it. @param {string} routeId */
export const spaceIdOf = routeId => `spc_${base32(sha(`space\n${routeId}`), 12)}`;

const ACTION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9*-]*)+$/;

/**
 * Check a GrantInput against what the contract allows Wink to write. Throws a coded Error.
 * @param {any} g
 */
export function checkGrantInput(g) {
  const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
  if (!g || typeof g !== "object") throw bad("a grant is an object");
  if (!g.subject || !["actor", "role", "group"].includes(g.subject.kind)) throw bad("a grant needs a subject: an actor, a role or a group");
  if (!Array.isArray(g.actions) || !g.actions.length || g.actions.some((/** @type {any} */ a) => typeof a !== "string" || !ACTION.test(a))) throw bad("a grant needs actions shaped noun.verb");
  if (!g.resource || typeof g.resource.prefix !== "string" || !/^vyre:\/\/spc_[a-z2-7]{12}\//.test(g.resource.prefix)) throw bad("a grant's resource is a vyre:// URN prefix inside one space");
  if (typeof g.source !== "string" || !/^(wink:W[0-8]|role:[a-z-]+|flow:|install:)/.test(g.source)) throw bad("a grant says where it came from (wink:W1 and so on)");
  const c = g.conditions || {};
  if (c.when && typeof c.when.expires !== "number") throw bad("a grant's expiry is a time in milliseconds");
  if (JSON.stringify(g).length > 8192) throw bad("a grant is at most 8 KB");
}

/** The grant table's migrations; the module passes them in its one `ctx.store.migrate` call, since a module has one migration list. */
export const MIGRATIONS = [
  `CREATE TABLE wink_grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL, subject_key TEXT NOT NULL, resource_prefix TEXT NOT NULL,
     body TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE INDEX wink_grants_subject ON wink_grants (subject_key, status)`,
];

/**
 * @param {{ ctx: any, space: () => string, now?: () => number }} o  space: the space this box's grants live in, read at each call (it is known once the relay has a route)
 */
export function createGrants({ ctx, space: spaceOf, now = Date.now }) {
  const db = ctx.store.db;
  const subjectKey = (/** @type {any} */ s) => s.kind === "actor" ? `actor:${s.actor.kind}:${s.actor.id}@${s.actor.space}` : `${s.kind}:${s.name || s.id}`;
  const row = (/** @type {any} */ r) => (r ? JSON.parse(r.body) : null);

  return {
    /** @param {any} input a GrantInput @param {any} issuer an Actor */
    async create(input, issuer) {
      checkGrantInput(input);
      const t = now();
      /** @type {any} */
      const g = { id: timeId("gr_", t), space: spaceOf(), subject: input.subject, actions: [...input.actions], action_set_version: 1, resource: input.resource,
        conditions: input.conditions || {}, issuer, source: input.source, ...(input.parent ? { parent: input.parent } : {}), status: "active", created_at: t, ...(input.reason ? { reason: input.reason } : {}) };
      db.prepare("INSERT INTO wink_grants (id, status, source, subject_key, resource_prefix, body, created_at) VALUES (?, 'active', ?, ?, ?, ?, ?)")
        .run(g.id, g.source, subjectKey(g.subject), g.resource.prefix, JSON.stringify(g), t);
      ctx.events.emit("grant.created", { grant: g });
      return g;
    },
    /** @param {string} id @param {string} reason */
    async revoke(id, reason) {
      const g = row(db.prepare("SELECT body FROM wink_grants WHERE id = ?").get(String(id)));
      if (!g) throw Object.assign(new Error("no such grant"), { code: "not_found" });
      if (g.status === "revoked") return g;
      const t = now();
      const out = { ...g, status: "revoked", revoked_at: t, reason: String(reason || "").slice(0, 200) };
      db.prepare("UPDATE wink_grants SET status = 'revoked', body = ?, revoked_at = ? WHERE id = ?").run(JSON.stringify(out), t, g.id);
      ctx.events.emit("grant.revoked", { grant: out });
      return out;
    },
    /** @param {{ subject?: any, resource_prefix?: string, status?: "active" | "revoked", source?: string }} [f] */
    async list(f = {}) {
      const rows = db.prepare("SELECT body FROM wink_grants ORDER BY created_at, id").all().map(row);
      return rows.filter((/** @type {any} */ g) => (!f.status || g.status === f.status) && (!f.source || g.source.startsWith(f.source))
        && (!f.resource_prefix || g.resource.prefix.startsWith(f.resource_prefix)) && (!f.subject || subjectKey(g.subject) === subjectKey(f.subject)));
    },
    /** @param {string} id */
    async get(id) { return row(db.prepare("SELECT body FROM wink_grants WHERE id = ?").get(String(id))) || null; },
  };
}
