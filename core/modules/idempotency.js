// @ts-check
// idempotency — a write a client retries runs once (docs/adr/0029-resilience.md, R2).
//
// A surface sends an Idempotency-Key with every call that changes something, and reuses it when
// it retries: after a lost response, a dropped path, a restart, or from its outbox. The registry
// remembers (caller, tool, key) with a hash of the input and what the tool answered, for 24 h.
// A repeat with the same input gets that answer back without the tool running again; a repeat
// with other input is refused, since it is a client bug that would otherwise pass silently.
// Only the tool's own answers are kept: a success, or a refusal carrying a code. A tool that
// crashed ("failed") may be retried.

import crypto from "node:crypto";
import { migrate } from "../store/index.js";

const DAY = 24 * 60 * 60 * 1000;

/** A stable hash of a tool's input, whatever order its keys arrive in. */
function hash(input) {
  const canon = v => Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  return crypto.createHash("sha256").update(JSON.stringify(canon(input ?? {}))).digest("hex");
}

export class Idempotency {
  /** @param {import("node:sqlite").DatabaseSync} db @param {{ now?: () => number, ttl?: number }} [o] */
  constructor(db, { now = Date.now, ttl = DAY } = {}) {
    this.db = db; this.now = now; this.ttl = ttl;
    migrate(db, "idempotency", [`
      CREATE TABLE idempotency (
        caller TEXT NOT NULL,
        tool TEXT NOT NULL,
        key TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (caller, tool, key)
      );
      CREATE INDEX idempotency_at ON idempotency(at);
    `]);
    /** Calls running now, so a retry that arrives mid-run waits for the same answer. */
    this.running = new Map();
    this.pruned = 0;
    this.get = db.prepare("SELECT input, result, at FROM idempotency WHERE caller = ? AND tool = ? AND key = ?");
    this.put = db.prepare("INSERT OR REPLACE INTO idempotency (caller, tool, key, input, result, at) VALUES (?,?,?,?,?,?)");
  }

  /**
   * Run `fn` once for this (caller, tool, key). Returns the registry's `{ data } | { error }`.
   * @param {{ caller: string, tool: string, key: string, input: any }} id
   * @param {() => Promise<{ data?: any, error?: any }>} fn
   */
  async once({ caller, tool, key, input }, fn) {
    const h = hash(input);
    const slot = `${caller}\n${tool}\n${key}`;
    const live = this.running.get(slot);
    if (live) return live.h === h ? live.p : conflict(tool);
    const row = /** @type {any} */ (this.get.get(caller, tool, key));
    if (row && this.now() - Number(row.at) < this.ttl) {
      if (row.input !== h) return conflict(tool);
      return { ...JSON.parse(String(row.result)), replayed: true };
    }
    const p = fn().then(r => {
      if (!(r.error && r.error.code === "failed")) this.put.run(caller, tool, key, h, JSON.stringify(r), this.now());
      return r;
    }).finally(() => { this.running.delete(slot); this.prune(); });
    this.running.set(slot, { h, p });
    return p;
  }

  /** Drop records past their day, at most once an hour. */
  prune() {
    if (this.now() - this.pruned < 60 * 60 * 1000) return;
    this.pruned = this.now();
    this.db.prepare("DELETE FROM idempotency WHERE at < ?").run(this.now() - this.ttl);
  }
}

function conflict(tool) {
  return { error: { code: "idempotency_conflict", message: `this Idempotency-Key was already used for ${tool} with other input; a retry must send the same input, a new write a new key` } };
}
