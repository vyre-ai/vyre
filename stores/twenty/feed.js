// @ts-check
// The change feed: what Twenty changes on its own (mail sync, imports, an edit made behind the
// gateway) arrives as a signed webhook and becomes a Change with source "twenty". The store's own
// writes echo back through the same webhook and are dropped by matching id and updatedAt (spike:
// 600 writes, 0 false changes). A webhook whose signature fails is recorded as rejected, not trusted.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SKEW_MS = 5 * 60 * 1000;

export class ChangeFeed {
  /**
   * @param {{ secret: string, file?: string | null, graceMs?: number, now?: () => number,
   *   resolve: (objectName: string) => { type: string, convert: (row: any) => Record<string, any>, hashOf: (row: any) => string } | null,
   *   snapshots: import("./snapshots.js").SnapshotStore, sleep?: (ms: number) => Promise<void> }} o
   */
  constructor(o) {
    this.secret = o.secret;
    this.file = o.file ?? null;
    this.graceMs = o.graceMs ?? 250;
    this.now = o.now ?? Date.now;
    this.resolve = o.resolve;
    this.snapshots = o.snapshots;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {import("../contract.js").Change[]} */ this.log = [];
    /** @type {Set<string>} */ this.self = new Set();
    /** @type {Map<string, number>} */ this.nonces = new Map();
    this.seq = 0;
    this.rejected = 0;
    if (this.file && fs.existsSync(this.file)) for (const l of fs.readFileSync(this.file, "utf8").split("\n")) { if (!l) continue; try { const c = JSON.parse(l); this.log.push(c); this.seq = Math.max(this.seq, c.seq); } catch { /* torn line */ } }
  }

  /** The store calls this right after its own write succeeds. @param {string} id @param {string} version */
  noteSelfWrite(id, version) { this.self.add(`${id}@${version}`); if (this.self.size > 20000) this.self.delete(this.self.values().next().value); }

  /**
   * @param {Record<string, string | string[] | undefined>} headers lower-case names
   * @param {string} rawBody
   * @returns {Promise<{ status: 200 | 401 | 400, recorded: number }>}
   */
  async handle(headers, rawBody) {
    const h = (/** @type {string} */ k) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
    /** @type {any} */ let body;
    try { body = JSON.parse(rawBody); } catch { return { status: 400, recorded: 0 }; }
    const ts = h("x-twenty-webhook-timestamp"), sig = h("x-twenty-webhook-signature"), nonce = h("x-twenty-webhook-nonce");
    const { secret: _drop, ...rest } = body;
    const want = crypto.createHmac("sha256", this.secret).update(`${ts}:${JSON.stringify(rest)}`).digest("hex");
    const a = Buffer.from(String(sig ?? ""), "utf8"), b = Buffer.from(want, "utf8");
    const okSig = a.length === b.length && crypto.timingSafeEqual(a, b);
    const tsMs = Number(ts) || Date.parse(String(ts));
    const fresh = Number.isFinite(tsMs) && Math.abs(this.now() - tsMs) < MAX_SKEW_MS;
    if (!okSig || !fresh) { this.rejected++; return { status: 401, recorded: 0 }; }
    if (nonce) { if (this.nonces.has(nonce)) return { status: 200, recorded: 0 }; this.nonces.set(nonce, this.now()); for (const [n, t] of this.nonces) if (this.now() - t > MAX_SKEW_MS) this.nonces.delete(n); }
    const objectName = body.objectMetadata?.nameSingular ?? String(body.eventName ?? "").split(".")[0];
    const kind = String(body.eventName ?? "").split(".").pop();
    const plan = this.resolve(objectName);
    const rec = body.record ?? {};
    if (!plan || !rec.id) return { status: 200, recorded: 0 }; // not one of our types
    const key = `${rec.id}@${rec.updatedAt}`;
    if (this.self.has(key)) { this.self.delete(key); return { status: 200, recorded: 0 }; }
    if (this.graceMs > 0) { await this.sleep(this.graceMs); if (this.self.has(key)) { this.self.delete(key); return { status: 200, recorded: 0 }; } }
    const after = plan.convert(rec);
    const before = this.snapshots.get(plan.type, rec.id)?.fields ?? null;
    const changed = Array.isArray(body.updatedFields) ? body.updatedFields.map(String) : before ? Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])) : Object.keys(after);
    const mapKind = { created: "created", updated: "updated", deleted: "deleted", restored: "restored", destroyed: "destroyed", upserted: "updated" };
    /** @type {import("../contract.js").Change} */
    const change = { seq: ++this.seq, at: new Date(this.now()).toISOString(), source: "twenty", kind: /** @type {any} */ (mapKind)[kind] ?? "updated", type: plan.type, id: rec.id, before, after, changed, version: rec.updatedAt ?? null, by: rec.updatedBy?.source ?? null };
    this.log.push(change);
    if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); fs.appendFileSync(this.file, JSON.stringify(change) + "\n", { mode: 0o600 }); }
    if (kind !== "deleted" && kind !== "destroyed") this.snapshots.set(plan.type, rec.id, { version: rec.updatedAt, hash: plan.hashOf(rec), fields: after });
    return { status: 200, recorded: 1 };
  }

  /** @param {number} since cursor from the last call (0 for all) @param {number} [limit] */
  changes(since, limit = 500) {
    const rows = this.log.filter((c) => c.seq > since).slice(0, limit);
    return { changes: rows, cursor: rows.length ? rows[rows.length - 1].seq : since };
  }
}
