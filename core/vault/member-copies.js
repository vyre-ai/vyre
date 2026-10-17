// @ts-check
// member-copies: a login a member shared with an agent, kept so the agent's Chrome can fill it while the member is away (V3a).
//
// The server can open these (they are sealed under a key made from the Space-held device key, like the logins the owner lends), so the rules are tight: a copy exists only because a member explicitly shared that
// one login with that one agent at Fill in; it is per agent, per login and per origin, and it is deleted the moment the share ends (unshare, expiry, the member's password change or removal, the member leaving).
//
// And it is NOT an item of the Space's vault. It sits in its own table and its own sealed files, under its own key, outside vault_items, so no list, get, reveal, copy, resolve, inject or render tool can find it by
// name: the owner and the admins cannot see or open a member's copy. Only agentFill (to type it into the agent's own Chrome) and the member's own share tools open this store. The agent is told a reference and a
// label, never a value. Nothing here is returned to a caller except metadata: a reference, the login's label, the agent, the origin, the expiry.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const FIELDS = ["username", "password", "totp"];

export class MemberCopies {
  /** @param {{ db: import("node:sqlite").DatabaseSync, dir: string, key: () => Promise<import("node:crypto").KeyObject>, clock: () => number }} v the vault: its database, its folder, its Space-held key */
  constructor(v) {
    this.v = v;
    this.db = v.db;
    this.dir = path.join(v.dir, "member-copies");
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_member_copies (
      ref TEXT PRIMARY KEY, owner TEXT NOT NULL, item TEXT NOT NULL, agent TEXT NOT NULL, uid TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, at INTEGER NOT NULL
    )`);
  }

  /** The reference an agent is told, and the audit shows: opaque, made from the four things that make the copy one. */
  static ref(/** @type {string} */ owner, /** @type {string} */ item, /** @type {string} */ agent, /** @type {string} */ origin) {
    return "mc-" + crypto.createHash("sha256").update([owner, item, agent, origin].join("\0")).digest("hex").slice(0, 20);
  }

  /** Its own key, made from the Space-held key and good for nothing else. */
  async subkey() {
    const vk = await this.v.key();
    const raw = vk.export();
    try { return Buffer.from(crypto.hkdfSync("sha256", raw, Buffer.from("vyre member copy salt"), Buffer.from("vyre member copy v1"), 32)); } finally { raw.fill(0); }
  }

  file(/** @type {string} */ ref) { return path.join(this.dir, ref + ".bin"); }

  /**
   * Keep (or refresh) the copy. @param {{ owner: string, item: string, agent: string, uid: string, origin: string, expires: number, fields: Record<string, string> }} c
   * @returns {Promise<string>} the reference
   */
  async put(c) {
    const ref = MemberCopies.ref(c.owner, c.item, c.agent, c.origin);
    const body = {}; for (const k of FIELDS) if (typeof c.fields[k] === "string" && c.fields[k]) body[k] = c.fields[k];
    if (!body.password) throw bad("a login to share has a password");
    const key = await this.subkey();
    try {
      const iv = crypto.randomBytes(12);
      const ci = crypto.createCipheriv("aes-256-gcm", key, iv);
      ci.setAAD(Buffer.from(ref));
      const sealed = Buffer.concat([iv, ci.update(JSON.stringify(body), "utf8"), ci.final(), ci.getAuthTag()]);
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = this.file(ref), tmp = f + ".tmp";
      fs.writeFileSync(tmp, sealed, { mode: 0o600 });
      fs.renameSync(tmp, f);
    } finally { key.fill(0); }
    this.db.prepare(`INSERT INTO vault_member_copies (ref, owner, item, agent, uid, origin, expires, at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(ref) DO UPDATE SET expires = excluded.expires, at = excluded.at, uid = excluded.uid`).run(ref, c.owner, c.item, c.agent, c.uid, c.origin, c.expires, this.v.clock());
    return ref;
  }

  /** The copy's metadata, or null: no such copy, or it has expired (then it is deleted here and now). @param {string} ref */
  find(ref) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_member_copies WHERE ref = ?").get(String(ref)));
    if (!r) return null;
    if (Number(r.expires) <= this.v.clock()) { this.remove(r.ref); return null; }
    return { ref: String(r.ref), owner: String(r.owner), item: String(r.item), agent: String(r.agent), uid: String(r.uid), origin: String(r.origin), expires: Number(r.expires) };
  }

  /** The values, for agentFill only. Throws if the file is gone or does not open. @param {string} ref @returns {Promise<{ username: string, password: string, totp: string }>} */
  async fields(ref) {
    if (!this.find(ref)) throw bad("no such shared login", "not_found");
    const b = fs.readFileSync(this.file(ref));
    const key = await this.subkey();
    try {
      const de = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      de.setAAD(Buffer.from(ref));
      de.setAuthTag(b.subarray(b.length - 16));
      const o = JSON.parse(Buffer.concat([de.update(b.subarray(12, b.length - 16)), de.final()]).toString("utf8"));
      return { username: String(o.username || ""), password: String(o.password || ""), totp: String(o.totp || "") };
    } catch { throw bad("the shared login could not be opened; share it again", "failed"); } finally { key.fill(0); }
  }

  /** Delete one copy: the row and the file. @param {string} ref */
  remove(ref) {
    this.db.prepare("DELETE FROM vault_member_copies WHERE ref = ?").run(String(ref));
    try { fs.rmSync(this.file(String(ref)), { force: true }); } catch { /* gone */ }
  }

  /** Delete every copy that matches, and say how many. @param {{ owner: string, item?: string, agent?: string, origin?: string }} q */
  removeBy(q) {
    let n = 0;
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT ref FROM vault_member_copies WHERE owner = ?" + (q.item ? " AND item = ?" : "") + (q.agent ? " AND agent = ?" : "") + (q.origin ? " AND origin = ?" : ""))
      .all(...[q.owner, q.item, q.agent, q.origin].filter(x => x !== undefined)))) { this.remove(r.ref); n++; }
    return n;
  }

  /** What a member has shared: metadata only. @param {string} owner */
  ofOwner(owner) {
    return /** @type {any[]} */ (this.db.prepare("SELECT ref, item, agent, origin, expires FROM vault_member_copies WHERE owner = ? ORDER BY at").all(String(owner)))
      .filter(r => Number(r.expires) > this.v.clock()).map(r => ({ ref: String(r.ref), item: String(r.item), agent: String(r.agent), origin: String(r.origin), expires: Number(r.expires) }));
  }

  /** The logins an agent may use from members, as the agent is told of them: a reference and a label, never a value. @param {string} uid */
  forAgent(uid) {
    return /** @type {any[]} */ (this.db.prepare("SELECT ref, item, origin, expires FROM vault_member_copies WHERE uid = ?").all(String(uid)))
      .filter(r => Number(r.expires) > this.v.clock()).map(r => ({ ref: String(r.ref), label: String(r.item), origin: String(r.origin) }));
  }

  /** Delete what has expired. @returns {number} */
  sweep() {
    let n = 0;
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT ref FROM vault_member_copies WHERE expires <= ?").all(this.v.clock()))) { this.remove(r.ref); n++; }
    return n;
  }
}
