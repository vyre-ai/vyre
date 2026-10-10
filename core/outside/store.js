// @ts-check
// outside/store: the registration of outside agents in the module's own database (private operational state: tokens as hashes, what each was given, what is waiting for the person). Business data is not
// here: what an agent reads and writes is records, under the kernel's grants. Pure of Vyre: a database and a clock in, plain rows out.
import crypto from "node:crypto";
import { newPrefixedId } from "../../lib/id.js";

export const MIGRATIONS = [
  `CREATE TABLE outside_agents (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'any', note TEXT, token_hash TEXT NOT NULL, expires INTEGER NOT NULL, rate INTEGER NOT NULL,
     uses INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, created_by TEXT, last_used INTEGER, revoked INTEGER
   );
   CREATE TABLE outside_reach (id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, grants TEXT NOT NULL, created INTEGER NOT NULL);
   CREATE INDEX outside_reach_agent ON outside_reach (agent);
   CREATE TABLE outside_held (
     id TEXT PRIMARY KEY, agent TEXT NOT NULL, tool TEXT NOT NULL, change TEXT NOT NULL, gate TEXT, state TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, settled INTEGER
   );
   CREATE INDEX outside_held_agent ON outside_held (agent);
   CREATE INDEX outside_held_gate ON outside_held (gate);`,
];

const sha = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest();
export const hashOf = (/** @type {string} */ token) => sha(token).toString("hex");
/** A token: `vext_` and 43 url-safe characters. Shown once. */
export const newToken = () => `vext_${crypto.randomBytes(32).toString("base64url")}`;
/** A new agent's random part: 24 lower-case letters and digits. */
export const newAgentId = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; const b = crypto.randomBytes(24); let s = ""; for (const x of b) s += a[x % a.length]; return s; };

/** @param {import("node:sqlite").DatabaseSync} db @param {() => number} now */
export function openStore(db, now) {
  const agent = (/** @type {string} */ id) => /** @type {any} */ (db.prepare("SELECT * FROM outside_agents WHERE id = ?").get(String(id)));
  return {
    agent,
    all: () => /** @type {any[]} */ (db.prepare("SELECT * FROM outside_agents ORDER BY created DESC").all()),
    /** @param {{ id: string, name: string, note?: string, token: string, expires: number, rate: number, by: string }} a */
    create(a) {
      db.prepare("INSERT INTO outside_agents (id, name, note, token_hash, expires, rate, created, created_by) VALUES (?,?,?,?,?,?,?,?)").run(a.id, a.name, a.note || null, hashOf(a.token), a.expires, a.rate, now(), a.by);
    },
    /** The agent a token opens, or null. Constant time over every agent, so the time says nothing about which token was close. @param {string} token */
    byToken(token) {
      const h = sha(String(token || ""));
      /** @type {any} */ let hit = null;
      for (const p of /** @type {any[]} */ (db.prepare("SELECT * FROM outside_agents").all())) if (crypto.timingSafeEqual(h, Buffer.from(p.token_hash, "hex"))) hit = p;
      return hit;
    },
    setToken: (/** @type {string} */ id, /** @type {string} */ token) => { db.prepare("UPDATE outside_agents SET token_hash = ? WHERE id = ?").run(hashOf(token), id); },
    setExpiry: (/** @type {string} */ id, /** @type {number} */ expires, /** @type {number} */ rate) => { db.prepare("UPDATE outside_agents SET expires = MAX(expires, ?), rate = ? WHERE id = ?").run(expires, rate, id); },
    setExpires: (/** @type {string} */ id, /** @type {number} */ expires) => { db.prepare("UPDATE outside_agents SET expires = ? WHERE id = ?").run(expires, id); },
    used: (/** @type {string} */ id) => { db.prepare("UPDATE outside_agents SET uses = uses + 1, last_used = ? WHERE id = ?").run(now(), id); },
    revoke: (/** @type {string} */ id) => { db.prepare("UPDATE outside_agents SET revoked = ? WHERE id = ? AND revoked IS NULL").run(now(), id); },
    status: (/** @type {any} */ a) => (a.revoked ? "revoked" : a.expires <= now() ? "expired" : "active"),

    reach: (/** @type {string} */ id) => /** @type {any[]} */ (db.prepare("SELECT * FROM outside_reach WHERE agent = ? ORDER BY created").all(id)).map(r => ({ ...r, spec: JSON.parse(r.spec), grants: JSON.parse(r.grants) })),
    /** @param {string} agentId @param {string} kind @param {any} spec @param {string[]} grants the kernel grant ids this reach became */
    addReach(agentId, kind, spec, grants) {
      const id = newPrefixedId("rc");
      db.prepare("INSERT INTO outside_reach (id, agent, kind, spec, grants, created) VALUES (?,?,?,?,?,?)").run(id, agentId, kind, JSON.stringify(spec), JSON.stringify(grants), now());
      return id;
    },
    dropReach: (/** @type {string} */ id) => { db.prepare("DELETE FROM outside_reach WHERE id = ?").run(id); },

    /** @param {{ id: string, agent: string, tool: string, change: any, gate: string | null }} h */
    hold(h) { db.prepare("INSERT INTO outside_held (id, agent, tool, change, gate, state, created) VALUES (?,?,?,?,?, 'waiting', ?)").run(h.id, h.agent, h.tool, JSON.stringify(h.change), h.gate, now()); },
    held: (/** @type {string} */ id) => { const r = /** @type {any} */ (db.prepare("SELECT * FROM outside_held WHERE id = ?").get(String(id))); return r ? { ...r, change: JSON.parse(r.change) } : null; },
    heldByGate: (/** @type {string} */ gate) => { const r = /** @type {any} */ (db.prepare("SELECT * FROM outside_held WHERE gate = ?").get(String(gate))); return r ? { ...r, change: JSON.parse(r.change) } : null; },
    heldOf: (/** @type {string} */ agentId) => /** @type {any[]} */ (db.prepare("SELECT * FROM outside_held WHERE agent = ? AND state = 'waiting'").all(agentId)),
    setGate: (/** @type {string} */ id, /** @type {string} */ gate) => { db.prepare("UPDATE outside_held SET gate = ? WHERE id = ?").run(gate, id); },
    settle: (/** @type {string} */ id, /** @type {string} */ state, error = "") => { db.prepare("UPDATE outside_held SET state = ?, error = ?, settled = ? WHERE id = ? AND state = 'waiting'").run(state, error || null, now(), id); },
  };
}
