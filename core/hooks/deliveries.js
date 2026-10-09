// @ts-check
// deliveries: verified webhook bodies, kept briefly for the watchers that read them.
//
// Only a delivery whose signature checked is stored. The table is bounded on every insert: the
// newest 500 and nothing older than seven days. It is a hand-off to a watcher, not an archive;
// what a watcher files is kept in the project.

import crypto from "node:crypto";
import { newPrefixedId } from "../../lib/id.js";

export const KEEP = 500;
export const KEEP_MS = 7 * 24 * 3600_000;

export const MIGRATIONS = [`
  CREATE TABLE hooks_deliveries (
    id TEXT PRIMARY KEY,
    route TEXT NOT NULL,
    at INTEGER NOT NULL,          -- ms since epoch
    headers TEXT NOT NULL,        -- JSON: the allowlisted headers only
    body BLOB NOT NULL,           -- the raw bytes that were signed
    bytes INTEGER NOT NULL,
    digest TEXT NOT NULL,         -- sha256 of the body, to drop a replay of the same delivery
    caller TEXT NOT NULL          -- internet:<route>, for the audit trail
  );
  CREATE INDEX hooks_deliveries_at ON hooks_deliveries(at);
  CREATE INDEX hooks_deliveries_route ON hooks_deliveries(route, digest);
`];

/**
 * The headers kept with a delivery. Never a signature, a cookie or an authorization header:
 * content type, user agent, and the event and delivery ids providers send.
 */
export const HEADERS = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-github-hook-id",
  "webhook-id", "x-webhook-id", "x-delivery-id", "x-event-type", "x-request-id"];

export class Deliveries {
  /** @param {import("node:sqlite").DatabaseSync} db @param {() => number} now */
  constructor(db, now) { this.db = db; this.now = now; }

  /**
   * Store one delivery unless the same body already arrived on this route (a replay, or a
   * sender's retry of one it already made). Prunes first.
   * @returns {{ id: string, at: number, duplicate: boolean }}
   */
  add(route, headers, body) {
    const at = this.now();
    this.db.prepare("DELETE FROM hooks_deliveries WHERE at < ?").run(at - KEEP_MS);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const seen = /** @type {any} */ (this.db.prepare("SELECT id, at FROM hooks_deliveries WHERE route = ? AND digest = ?").get(route, digest));
    if (seen) return { id: String(seen.id), at: Number(seen.at), duplicate: true };
    const kept = {};
    for (const h of HEADERS) {
      const v = headers[h];
      if (typeof v === "string" && v) kept[h] = v.slice(0, 300);
    }
    const id = newPrefixedId("hd");
    this.db.prepare("INSERT INTO hooks_deliveries (id, route, at, headers, body, bytes, digest, caller) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, route, at, JSON.stringify(kept), body, body.length, digest, `internet:${route}`);
    this.db.prepare(`DELETE FROM hooks_deliveries WHERE id IN
      (SELECT id FROM hooks_deliveries ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(KEEP);
    return { id, at, duplicate: false };
  }

  /** One delivery, with its body as text (JSON and form bodies are text), or null. */
  get(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM hooks_deliveries WHERE id = ?").get(String(id)));
    if (!r) return null;
    return { id: r.id, route: r.route, at: new Date(Number(r.at)).toISOString(), headers: JSON.parse(String(r.headers)),
      bytes: Number(r.bytes), body: Buffer.from(/** @type {Uint8Array} */ (r.body)).toString("utf8") };
  }

  /** The newest few for a route, without bodies. */
  recent(route, limit = 5) {
    return this.db.prepare("SELECT id, at, bytes FROM hooks_deliveries WHERE route = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(route, limit)
      .map(r => ({ id: String(r.id), at: new Date(Number(r.at)).toISOString(), bytes: Number(r.bytes) }));
  }

  count(route) { return Number(/** @type {any} */ (this.db.prepare("SELECT COUNT(*) n FROM hooks_deliveries WHERE route = ?").get(route)).n); }
}
