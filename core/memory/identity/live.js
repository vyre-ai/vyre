// @ts-check
// identity/live — the identity home (home.js) joined to the memory database on a space server.
//
// On a server the person's identity memory (the personal tables) is not kept in the clear at rest. Enrolling moves it into the identity home as ciphertext and removes the rows from the
// database; unlocking (the person's phone said yes, for their own assistant's session) puts the rows back for a short lease; locking, or the lease running out, saves what changed and takes
// them out again. Locked, the database holds none of it and the memory tools answer "locked". The rows are deleted with `secure_delete` on and the write-ahead log is truncated, so the
// pages that held them are overwritten, not just unlinked. (The person's own sessions' text is the project layer's and the Space storage's, not this layer's.)

import { IdentityHome, FileBackend, Lease } from "./home.js";

/** The tables that are the person's identity memory: what they said about themselves and their life, what memory answered from it, and what was offered to correct it. */
export const IDENTITY_TABLES = Object.freeze([
  "memory_me_claims", "memory_me_cursor", "memory_me_entities", "memory_me_aliases", "memory_me_facts", "memory_me_evidence", "memory_me_budget", "memory_me_cues", "memory_me_model",
  "memory_me_told", "memory_me_queue", "memory_me_reads", "memory_me_trust", "memory_me_denied", "memory_iq_answers", "memory_iq_asks", "memory_iq_suggested",
]);

/** @param {import("node:sqlite").DatabaseSync} db @param {string} t */
const exists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

/** The identity tables as plain rows. @param {import("node:sqlite").DatabaseSync} db */
export function exportTables(db) {
  /** @type {Record<string, any[]>} */ const tables = {};
  for (const t of IDENTITY_TABLES) if (exists(db, t)) tables[t] = /** @type {any[]} */ (db.prepare(`SELECT * FROM ${t}`).all()).map(r => ({ ...r }));
  return tables;
}

/** Put rows back: each table is replaced by what the snapshot holds. @param {import("node:sqlite").DatabaseSync} db @param {Record<string, any[]>} tables */
export function importTables(db, tables) {
  db.exec("BEGIN");
  try {
    for (const t of IDENTITY_TABLES) {
      if (!exists(db, t)) continue;
      db.exec(`DELETE FROM ${t}`);
      for (const r of tables[t] || []) {
        const cols = Object.keys(r);
        db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map(c => r[c]));
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Remove the rows for good: deleted with secure_delete on, then the log truncated. @param {import("node:sqlite").DatabaseSync} db */
export function purgeTables(db) {
  db.exec("PRAGMA secure_delete = ON");
  db.exec("BEGIN");
  try { for (const t of IDENTITY_TABLES) if (exists(db, t)) db.exec(`DELETE FROM ${t}`); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* not in WAL mode */ }
}

export class IdentityLive {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, id: string, backend: FileBackend, now?: () => number, log?: (m: string) => void }} o
   */
  constructor({ db, id, backend, now = Date.now, log = () => {} }) {
    this.db = db; this.home = new IdentityHome({ id, backend, now }); this.now = now; this.log = log;
    /** @type {Lease|null} */ this.lease = null;
    /** @type {Map<string, { secret: any, ask: any, at: number }>} the asks the assistant's sessions have open, by request */
    this.asks = new Map();
    /** @type {NodeJS.Timeout|null} */ this.timer = null;
  }

  /** Is the identity memory kept sealed here (a home exists on this backend)? */
  get sealed() { return this.home.exists(); }
  /** Are the rows in the database right now? */
  get unlocked() { return Boolean(this.lease && this.lease.open); }

  status() {
    const m = this.home.manifest();
    return { kept: m && !m.moved_to ? "here" : this.home.movedTo() ? "moved" : "none", ...(this.home.movedTo() ? { moved_to: this.home.movedTo() } : {}), rev: m ? m.rev : null, unlocked: this.unlocked,
      devices: m ? m.wraps.filter((/** @type {any} */ w) => w.kind === "device").length : 0, recovery_code: Boolean(m && m.wraps.some((/** @type {any} */ w) => w.kind === "code")) };
  }

  /**
   * Seal what the database holds now: a home made for these devices, the rows moved into it and removed from the database. The person's own act.
   * @param {{ devices: { label?: string, publicJwk: any }[], recoveryCode?: string, state?: any }} o
   */
  enroll({ devices, recoveryCode, state = {} }) {
    const lease = this.home.create({ devices, ...(recoveryCode ? { recoveryCode } : {}), snapshot: { v: 1, tables: exportTables(this.db), state } });
    purgeTables(this.db);
    lease.lock();
    this.lease = null;
    return this.status();
  }

  /** An assistant session asks to unlock. @returns {{ ask: any }} what the phone's card shows and signs over */
  begin() {
    const { ask, secret } = this.home.beginUnlock();
    for (const [k, v] of this.asks) if (this.now() - v.at > 10 * 60_000) this.asks.delete(k);
    this.asks.set(ask.request, { secret, ask, at: this.now() });
    return { ask };
  }

  /** The phone's answer arrives (its yes already checked by the caller): the rows come back for the lease. @param {string} request @param {any} answer */
  finish(request, answer) {
    const open = this.asks.get(request);
    if (!open) throw Object.assign(new Error("no unlock is waiting for that request"), { code: "not_found" });
    this.asks.delete(request);                                                             // one use
    const lease = this.home.finishUnlock(open.ask, open.secret, answer);
    importTables(this.db, this.home.load(lease).tables || {});
    this.lease = lease;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.lock(); } catch (e) { this.log(`identity memory: could not lock at the end of its lease: ${/** @type {Error} */ (e).message}`); } }, Math.max(1, lease.expires - this.now() - 5000));
    this.timer.unref?.();
    return this.status();
  }

  /** Save what changed, take the rows out again, and drop the key. Safe to call when locked. */
  lock() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const lease = this.lease;
    this.lease = null;
    if (!lease) return this.status();
    try { if (lease.open) this.home.save(lease, { v: 1, tables: exportTables(this.db), state: this.home.load(lease).state || {} }); }
    finally { purgeTables(this.db); lease.lock(); }
    return this.status();
  }

  /** Move the sealed home to another server's folder. The rows stay out of the database; nothing is decrypted. @param {FileBackend} to */
  move(to) {
    if (this.unlocked) this.lock();
    const r = this.home.move(to);
    this.home = new IdentityHome({ id: this.home.id, backend: to, now: this.now });
    return r;
  }

  /** Stop: the rows go back into their ciphertext. */
  stop() { try { this.lock(); } catch { /* best effort */ } }
}
