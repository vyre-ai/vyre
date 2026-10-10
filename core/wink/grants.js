// @ts-check
// grants: what Wink grants (a member joining, a computer lent, a storage device) are kernel grants: Wink makes them through the kernel's `mint` handle, inside `needs.kernel.mints` in its manifest, from a
// source that starts `wink:`. The kernel writes the event. Wink keeps no grant table of its own; the old tables stay only until `moveLocalGrants` has carried their rows over (one grant model).

import crypto from "node:crypto";
import { base32 as libBase32 } from "../../lib/bytes.js";

/** A time-prefixed id: 48 bits of the time in hex, then 12 random bytes. @param {string} prefix @param {number} t */
export const timeId = (prefix, t) => `${prefix}${t.toString(16).padStart(12, "0")}-${crypto.randomBytes(12).toString("hex")}`;
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
/** base32 (lowercase, no padding) of bytes, first n characters. @param {Uint8Array} b @param {number} n */
export const base32 = (b, n) => libBase32(b).slice(0, n);
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

/** Migrations of the old grant table. Kept because a migration that ran cannot be unwritten; the table is empty after `moveLocalGrants` and a later release drops it. */
export const MIGRATIONS = [
  `CREATE TABLE wink_grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL, subject_key TEXT NOT NULL, resource_prefix TEXT NOT NULL,
     body TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE INDEX wink_grants_subject ON wink_grants (subject_key, status)`,
];

const subjectKey = (/** @type {any} */ s) => s.kind === "actor" ? `actor:${s.actor.kind}:${s.actor.id}@${s.actor.space}` : `${s.kind}:${s.name || s.id}`;

/** The kernel's mint handle, or the plain reason there is none. @param {any} ctx */
function mintOf(ctx) {
  const m = ctx && ctx.kernel && ctx.kernel.mint;
  if (!m) throw Object.assign(new Error("this server has no kernel to keep the grant in, so nothing was added"), { code: "unavailable" });
  return m;
}

/** A grant lives in the kernel's own Space, so its addresses and its actors say that Space (Wink's stand-in id from the relay route is only a name for it until then). @param {any} ctx @param {any} input */
function inKernelSpace(ctx, input) {
  const sp = ctx && ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : "";
  if (!sp) return input;
  const actor = input.subject && input.subject.kind === "actor" ? { ...input.subject, actor: { ...input.subject.actor, space: sp } } : input.subject;
  return { ...input, subject: actor, resource: { ...input.resource, prefix: String(input.resource.prefix).replace(/^vyre:\/\/[^/]+\//, `vyre://${sp}/`) } };
}

/**
 * The grants Wink made, through the kernel. A revoked grant is gone from `get` and `list` (the kernel's log keeps the history), so `status: "revoked"` lists nothing.
 * @param {{ ctx: any }} o
 */
export function createGrants({ ctx }) {
  /** @param {string} [source] @returns {Promise<any[]>} */
  const held = async source => mintOf(ctx).list({ source: source || "wink:" });
  return {
    /** @param {any} input a GrantInput */
    async create(given) {
      checkGrantInput(given);
      const input = inKernelSpace(ctx, given);
      const id = await mintOf(ctx).make({ subject: input.subject, actions: [...input.actions], resource: input.resource, conditions: input.conditions || {}, source: input.source, ...(input.reason ? { reason: input.reason } : {}) });
      const g = (await held(input.source)).find(x => x.id === id);
      if (!g) throw Object.assign(new Error("the kernel did not keep the grant"), { code: "failed" });
      return g;
    },
    /** Ending a grant that is already gone is the same as ending it. @param {string} id @param {string} reason */
    async revoke(id, reason) {
      await mintOf(ctx).end({ id: String(id), reason: String(reason || "").slice(0, 200) });
      return { id: String(id), status: "revoked" };
    },
    /** @param {{ subject?: any, resource_prefix?: string, status?: "active" | "revoked", source?: string }} [f] */
    async list(f = {}) {
      if (f.status === "revoked") return [];
      return (await held(f.source)).filter(g => (!f.resource_prefix || g.resource.prefix.startsWith(f.resource_prefix)) && (!f.subject || subjectKey(g.subject) === subjectKey(f.subject)));
    },
    /** @param {string} id */
    async get(id) { return (await held()).find(g => g.id === String(id)) || null; },
  };
}

/**
 * The once-only move of the old tables' active rows into kernel grants (the first start after the update, which backs up first). A member grant's resource narrows from the Space root to
 * `member/<person>`, a storage device's `grant_id` follows its new grant, and a device grant an older build wrote is handed to `adoptDevice` (it becomes a registry row, not a grant). The rows go
 * once they are carried. A server with no kernel keeps them where they are and tries again at the next start.
 * @param {{ ctx: any, adoptDevice: (row: any) => void }} o @returns {Promise<number>} grants moved
 */
export async function moveLocalGrants({ ctx, space, adoptDevice }) {
  const db = ctx.store.db;
  const has = (/** @type {string} */ t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  const rows = [
    ...(has("wink_grants") ? db.prepare("SELECT id, body FROM wink_grants WHERE status = 'active' ORDER BY created_at, id").all().map((/** @type {any} */ r) => ({ ...r, table: "wink_grants" })) : []),
    ...(has("wink_storage_grants") ? db.prepare("SELECT id, body FROM wink_storage_grants WHERE status = 'active'").all().map((/** @type {any} */ r) => ({ ...r, table: "wink_storage_grants" })) : []),
  ].map((/** @type {any} */ r) => ({ id: r.id, table: r.table, g: JSON.parse(r.body) }));
  if (!rows.length) return 0;
  const mint = mintOf(ctx);
  let moved = 0;
  // a row goes the moment its grant is made, so a stop in the middle leaves each grant either moved or still waiting, never both
  for (const { id, table, g } of rows) {
    const sub = g.subject.kind === "actor" ? g.subject.actor : null;
    if (sub && sub.kind === "device" && g.actions.includes("space.act")) { adoptDevice(g); db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); continue; }
    const root = /^vyre:\/\/[^/]+\/$/;
    const resource = root.test(g.resource.prefix) && g.actions.includes("member.act") && sub ? { ...g.resource, prefix: `${g.resource.prefix}member/${sub.id}` } : g.resource;
    const given = inKernelSpace(ctx, { subject: g.subject, resource });
    const made = await mint.make({ subject: given.subject, actions: g.actions, resource: given.resource, conditions: g.conditions || {}, source: g.source, ...(g.reason ? { reason: g.reason } : {}) });
    if (has("wink_storage_devices")) db.prepare("UPDATE wink_storage_devices SET grant_id = ? WHERE grant_id = ?").run(made, id);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    moved++;
  }
  // rows that were already revoked carry no authority; the kernel's log has the history
  if (has("wink_grants")) db.prepare("DELETE FROM wink_grants").run();
  if (has("wink_storage_grants")) db.prepare("DELETE FROM wink_storage_grants").run();
  return moved;
}
