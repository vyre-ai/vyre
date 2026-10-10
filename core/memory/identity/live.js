// @ts-check
// identity/live — the identity home (home.js) joined to the memory database on a space server.
//
// The identity tables (the personal facts, what memory answered from them, what was offered to correct them) are never in the clear on disk once the person seals them. Sealing moves the rows
// into the identity home as ciphertext and relocates the tables into an in-memory schema of the same connection (`idmem`): every query, which names the tables unqualified, now finds them
// there, and the disk database has no such tables. Unlocked, the rows are in process memory only; new facts reach the disk only as ciphertext (the home is re-saved when they change, within
// `autosaveMs`, and at lock and stop). A crash or a kill therefore leaves the disk holding ciphertext and nothing else; at most the last few seconds of facts are lost.

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema.js";
import { migrate } from "../../store/index.js";
import { IdentityHome, FileBackend, Lease, newServerKey } from "./home.js";
import { fingerprint } from "../../../lib/keywrap.js";

/** The tables that are the person's identity memory: what they said about themselves and their life, what memory answered from it, and what was offered to correct it. */
export const IDENTITY_TABLES = Object.freeze([
  "memory_me_claims", "memory_me_cursor", "memory_me_entities", "memory_me_aliases", "memory_me_facts", "memory_me_evidence", "memory_me_budget", "memory_me_cues", "memory_me_model",
  "memory_me_told", "memory_me_queue", "memory_me_reads", "memory_me_trust", "memory_me_denied", "memory_iq_answers", "memory_iq_asks", "memory_iq_suggested",
]);
const SCHEMA = "idmem";

/** @param {import("node:sqlite").DatabaseSync} db @param {string} schema @param {string} t */
const has = (db, schema, t) => Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(t));
/** @param {import("node:sqlite").DatabaseSync} db */
const attached = db => /** @type {any[]} */ (db.prepare("PRAGMA database_list").all()).some(r => r.name === SCHEMA);

/** The identity tables as plain rows (wherever they are now). @param {import("node:sqlite").DatabaseSync} db */
export function exportTables(db) {
  /** @type {Record<string, any[]>} */ const tables = {};
  const schema = attached(db) ? SCHEMA : "main";
  for (const t of IDENTITY_TABLES) if (has(db, schema, t)) tables[t] = /** @type {any[]} */ (db.prepare(`SELECT * FROM ${schema}.${t}`).all()).map(r => ({ ...r }));
  return tables;
}

/** Put rows back: each table is replaced by what the snapshot holds. @param {import("node:sqlite").DatabaseSync} db @param {Record<string, any[]>} tables */
export function importTables(db, tables) {
  const schema = attached(db) ? SCHEMA : "main";
  db.exec("BEGIN");
  try {
    for (const t of IDENTITY_TABLES) {
      if (!has(db, schema, t)) continue;
      db.exec(`DELETE FROM ${schema}.${t}`);
      for (const r of tables[t] || []) {
        const cols = Object.keys(r);
        db.prepare(`INSERT INTO ${schema}.${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map(c => r[c]));
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Empty the in-memory tables (the rows leave the process). @param {import("node:sqlite").DatabaseSync} db */
export function clearTables(db) {
  if (!attached(db)) return;
  db.exec("BEGIN");
  try { for (const t of IDENTITY_TABLES) if (has(db, SCHEMA, t)) db.exec(`DELETE FROM ${SCHEMA}.${t}`); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/**
 * Move the identity tables off the disk: made again, empty, in an in-memory schema, and dropped from the file with `secure_delete` on (the pages are overwritten) and the log truncated.
 * Safe to repeat. Whatever rows the file held are dropped with it: the caller exported them first.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function relocate(db) {
  // SQLite never spills a sort or a temporary table to a file while the identity memory is open: temp storage stays in memory too.
  db.exec("PRAGMA temp_store = MEMORY");
  if (!attached(db)) db.exec(`ATTACH DATABASE ':memory:' AS ${SCHEMA}`);
  // The tables' definitions come from the memory migrations themselves, run in a scratch database: once they are dropped from the file there is nowhere else to read them, and a restart must
  // find them. (A future migration that alters one of these tables must alter it where it lives: the in-memory schema, made from the migrations as they stand.)
  const scratch = new DatabaseSync(":memory:");
  /** @type {any[]} */ let ddl;
  try {
    scratch.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER, PRIMARY KEY (module, version))");
    migrate(scratch, "memory", MIGRATIONS);
    ddl = /** @type {any[]} */ (scratch.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (" + IDENTITY_TABLES.map(() => "?").join(",") + ") AND sql IS NOT NULL ORDER BY type DESC").all(...IDENTITY_TABLES));
  } finally { scratch.close(); }
  for (const d of ddl) {
    if (d.type === "table" && !has(db, SCHEMA, d.name)) db.exec(String(d.sql).replace(/^CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i, `CREATE TABLE ${SCHEMA}.$1`));
  }
  for (const d of ddl) {
    if (d.type === "index") { try { db.exec(String(d.sql).replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/i, `CREATE $1INDEX IF NOT EXISTS ${SCHEMA}.$2`)); } catch { /* an index the schema already has */ } }
  }
  db.exec("PRAGMA secure_delete = ON");
  for (const t of IDENTITY_TABLES) if (has(db, "main", t)) db.exec(`DROP TABLE main.${t}`);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* not in WAL mode */ }
}

/** A hash of the rows, to know whether they changed since they were last sealed. @param {any} tables */
const digest = tables => crypto.createHash("sha256").update(JSON.stringify(tables)).digest("hex");

export class IdentityLive {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, id: string, backend: FileBackend, serverKey?: { publicJwk: any, privateJwk: any }|null, serverName?: string, now?: () => number, log?: (m: string) => void,
   *   autosaveMs?: number, onAsk?: (ask: any) => void }} o
   */
  constructor({ db, id, backend, serverKey = null, serverName = "this server", now = Date.now, log = () => {}, autosaveMs = 30_000, onAsk = () => {} }) {
    this.db = db; this.home = new IdentityHome({ id, backend, now }); this.now = now; this.log = log; this.autosaveMs = autosaveMs; this.onAsk = onAsk;
    this.server = serverKey ? { name: serverName, publicJwk: serverKey.publicJwk, privateJwk: serverKey.privateJwk } : null;
    /** @type {Lease|null} */ this.lease = null;
    /** @type {Map<string, { secret: any, ask: any, at: number }>} the asks the assistant's sessions have open, by request */
    this.asks = new Map();
    /** @type {NodeJS.Timeout|null} */ this.timer = null;
    /** @type {string|null} */ this.saved = null;
    /** Sealed means there is a home: from here the tables live only in memory. */
    if (this.sealed) relocate(db);
  }

  /** Is the identity memory kept sealed here (a home exists on this backend)? */
  get sealed() { return this.home.exists(); }
  /** Are the rows in the process right now? */
  get unlocked() { return Boolean(this.lease && this.lease.open); }
  /** This server's own fingerprint, which the person's phone grants. */
  get serverFp() { return this.server ? fingerprint(this.server.publicJwk) : null; }

  status() {
    const m = this.home.manifest();
    return { kept: m && !m.moved_to ? "here" : this.home.movedTo() ? "moved" : "none", ...(this.home.movedTo() ? { moved_to: this.home.movedTo() } : {}), rev: m ? m.rev : null, unlocked: this.unlocked,
      devices: m ? m.wraps.filter((/** @type {any} */ w) => w.kind === "device").length : 0, recovery_code: Boolean(m && m.wraps.some((/** @type {any} */ w) => w.kind === "code")),
      granted: this.home.grants().map(g => ({ server: g.server, fp: g.fp, at: g.at })), server: this.serverFp, server_key: this.server ? this.server.publicJwk : null, id: this.home.id };
  }

  /**
   * Seal what the database holds now: a home made for these devices, the rows moved into it and off the disk. The person's own act.
   * @param {{ devices: { label?: string, publicJwk: any }[], recoveryCode?: string, recoveryPassword?: string, state?: any }} o
   */
  enroll({ devices, recoveryCode, recoveryPassword = "", state = {} }) {
    const lease = this.home.create({ devices, ...(recoveryCode ? { recoveryCode, recoveryPassword } : {}), snapshot: { v: 1, tables: exportTables(this.db), state } });
    relocate(this.db);
    lease.lock();
    this.lease = null;
    return this.status();
  }

  /** The person said yes, once, for this server's assistant: recorded, and the phone answers this server's requests from now on. @param {{ server?: string }} [o] */
  grant({ server = this.server ? this.server.name : "this server" } = {}) {
    if (!this.server) throw Object.assign(new Error("this server has no key of its own to be granted; the person unlocks their memory from their own device instead"), { code: "unavailable" });
    this.home.addGrant({ server, fp: /** @type {string} */ (this.serverFp) });
    return this.status();
  }

  /** The person revoked it from their phone: locked now, and no request is answered again. */
  revoke() {
    this.home.removeGrant();
    this.asks.clear();
    return this.lock();
  }

  /** An assistant session asks to unlock. @returns {{ ask: any }} what the phone is shown (and answers by itself for a server it was granted) */
  begin() {
    const { ask, secret } = this.home.beginUnlock(this.server);
    for (const [k, v] of this.asks) if (this.now() - v.at > 10 * 60_000) this.asks.delete(k);
    this.asks.set(ask.request, { secret, ask, at: this.now() });
    return { ask };
  }

  /** After a start, the phone is told this server wants the memory unlocked (only while a grant stands): it answers by calling unlock.begin and then unlock.finish. Returns whether it was asked. */
  askPhone() {
    if (!this.sealed || this.unlocked || !this.home.grants().length) return false;
    try { this.onAsk({ server: this.server ? this.server.name : "this server" }); } catch (e) { this.log(`identity memory: could not ask the phone: ${/** @type {Error} */ (e).message}`); }
    return true;
  }

  /** @param {Lease} lease */
  #open(lease) {
    importTables(this.db, this.home.load(lease).tables || {});
    this.lease = lease;
    this.saved = digest(exportTables(this.db));
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { try { this.save(); } catch (e) { this.log(`identity memory: could not seal the latest facts: ${/** @type {Error} */ (e).message}`); } }, this.autosaveMs);
    this.timer.unref?.();
  }

  /** The phone's answer arrives: the rows come into the process, and stay there until lock, revoke or the process ends. A request is one use. @param {string} request @param {any} answer */
  async finish(request, answer) {
    const open = this.asks.get(request);
    if (!open) throw Object.assign(new Error("no unlock is waiting for that request (it may be answered already; memory.identity.unlock.begin asks again)"), { code: "not_found" });
    this.asks.delete(request);
    // the standing grant must be for the server that asked: a grant for server A never finishes an ask from server B
    const fp = open.ask.server && open.ask.server.fp;
    if (!fp || !this.home.grants().some(g => g.fp === fp)) throw Object.assign(new Error("this server was not given the person's memory (or it was revoked)"), { code: "denied" });
    this.#open(await this.home.finishUnlock(open.ask, open.secret, answer));
    return this.status();
  }

  /** On the person's own device: its key unwraps with no prompt. @param {{ privateJwk: any, publicJwk: any }} device */
  async unlockLocal(device) {
    this.#open(await this.home.unlockWithDevice(device));
    return this.status();
  }

  /** Whether facts changed since the last seal (the upgrade seals first). */
  unsaved() { return Boolean(this.lease && this.lease.open && this.saved !== digest(exportTables(this.db))); }

  /** Seal what changed since the last time, as ciphertext. */
  save() {
    const lease = this.lease;
    if (!lease || !lease.open) return false;
    const tables = exportTables(this.db), d = digest(tables);
    if (d === this.saved) return false;
    this.home.save(lease, { v: 1, tables, state: this.home.load(lease).state || {} });
    this.saved = d;
    return true;
  }

  /** Seal the latest, take the rows out of the process and drop the key. Safe to call when locked. */
  lock() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const lease = this.lease;
    this.lease = null;
    if (!lease) return this.status();
    try { if (lease.open && !this.home.movedTo()) { this.lease = lease; try { this.save(); } finally { this.lease = null; } } }
    finally { clearTables(this.db); lease.lock(); }
    return this.status();
  }

  /** Move the sealed home to another server's folder. The rows stay out of the disk; nothing is decrypted. @param {FileBackend} to */
  move(to) {
    if (this.unlocked) this.lock();
    const r = this.home.move(to);
    this.home = new IdentityHome({ id: this.home.id, backend: to, now: this.now });
    return r;
  }

  /** Stop: the latest facts are sealed and the rows leave the process. */
  stop() { try { this.lock(); } catch { /* best effort */ } }
}

export { newServerKey };
