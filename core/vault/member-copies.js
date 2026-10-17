// @ts-check
// member-copies: the record of the logins members shared with agents (V3a). The values are NOT here. A shared login's copy sits in the member's OWN vault, in the folder of what she lends, sealed under her lend key
// (PeopleVaults.lent, people.js): that key alone is also sealed for the server, so the server opens lent copies and nothing else of hers, and no vault.* tool of the Space, the owner's and the admins' included,
// can list or reveal them. This table holds only what is needed to find and end a share: an opaque reference, who shared, a hash of the login's name (the name itself is in the sealed copy), which agent, which
// site, until when. A copy is per agent, per login and per origin, and it is deleted the moment its share ends.

import crypto from "node:crypto";

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const sha = (/** @type {string[]} */ ...p) => crypto.createHash("sha256").update(p.join("\0")).digest("hex");
const FIELDS = ["username", "password", "totp"];

export class MemberCopies {
  /** @param {{ db: import("node:sqlite").DatabaseSync, clock: () => number }} v the vault @param {() => any} people the member vaults (PeopleVaults), once they exist */
  constructor(v, people) {
    this.v = v; this.db = v.db; this.people = people;
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_member_copies (
      ref TEXT PRIMARY KEY, owner TEXT NOT NULL, item_h TEXT NOT NULL, agent TEXT NOT NULL, uid TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** The reference an agent is told, and the audit shows: opaque, made from the four things that make the copy one. */
  static ref(/** @type {string} */ owner, /** @type {string} */ item, /** @type {string} */ agent, /** @type {string} */ origin) { return "mc-" + sha(owner, item, agent, origin).slice(0, 20); }
  /** What the table keeps of a login's name: a hash, so the name stays in the member's sealed copy. */
  static itemHash(/** @type {string} */ owner, /** @type {string} */ item) { return sha("item", owner, item).slice(0, 32); }

  lent(/** @type {string} */ owner) { const p = this.people(); if (!p) throw bad("the member vaults are not running", "unavailable"); return p.lent(owner); }

  /**
   * Keep (or refresh) the copy in the member's lend folder, and the row that finds it. @param {{ owner: string, item: string, agent: string, uid: string, origin: string, expires: number, fields: Record<string, string> }} c
   * @returns {Promise<string>} the reference
   */
  async put(c) {
    const ref = MemberCopies.ref(c.owner, c.item, c.agent, c.origin);
    /** @type {Record<string, string>} */ const body = {}; for (const k of FIELDS) if (typeof c.fields[k] === "string" && c.fields[k]) body[k] = c.fields[k];
    if (!body.password) throw bad("a login to share has a password");
    await this.lent(c.owner).put(ref, { kind: "login", description: c.item, fields: body });
    this.db.prepare(`INSERT INTO vault_member_copies (ref, owner, item_h, agent, uid, origin, expires, at, gone) VALUES (?,?,?,?,?,?,?,?,0)
      ON CONFLICT(ref) DO UPDATE SET expires = excluded.expires, at = excluded.at, uid = excluded.uid, gone = 0`).run(ref, c.owner, MemberCopies.itemHash(c.owner, c.item), c.agent, c.uid, c.origin, c.expires, this.v.clock());
    return ref;
  }

  /** The copy's metadata, or null: no such copy, one being deleted, or an expired one (then its deletion starts here and now). @param {string} ref */
  find(ref) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_member_copies WHERE ref = ?").get(String(ref)));
    if (!r || r.gone) return null;
    if (Number(r.expires) <= this.v.clock()) { void this.remove(r.ref); return null; }
    return { ref: String(r.ref), owner: String(r.owner), agent: String(r.agent), uid: String(r.uid), origin: String(r.origin), expires: Number(r.expires) };
  }

  /** The values, for agentFill only: opened with the member's lend key (hers when unlocked, else the sealed server copy). @param {string} ref @returns {Promise<{ username: string, password: string, totp: string }>} */
  async fields(ref) {
    const c = this.find(ref);
    if (!c) throw bad("no such shared login", "not_found");
    const it = await this.lent(c.owner).get(ref);
    return { username: String(it.fields.username || ""), password: String(it.fields.password || ""), totp: String(it.fields.totp || "") };
  }

  /** The member's name for the login, from the sealed copy. @param {string} ref @param {string} owner */
  async label(ref, owner) { try { return String((await this.lent(owner).get(ref)).description || ""); } catch { return ""; } }

  /** Delete one copy: the sealed file, then the row. If the file cannot be reached now (her vault is locked and no sealed key is held) the row stays, marked gone and never used, and a sweep tries again. @param {string} ref */
  async remove(ref) {
    const r = /** @type {any} */ (this.db.prepare("SELECT owner FROM vault_member_copies WHERE ref = ?").get(String(ref)));
    if (!r) return;
    this.db.prepare("UPDATE vault_member_copies SET gone = 1 WHERE ref = ?").run(String(ref));
    try { await this.lent(String(r.owner)).remove(String(ref)); this.db.prepare("DELETE FROM vault_member_copies WHERE ref = ?").run(String(ref)); }
    catch (e) { if (/** @type {any} */ (e).code === "not_found") this.db.prepare("DELETE FROM vault_member_copies WHERE ref = ?").run(String(ref)); }
  }

  /** The references that match a person, and optionally a login (by name), an agent, a site. @param {{ owner: string, item?: string, agent?: string, origin?: string }} q */
  match(q) {
    return /** @type {any[]} */ (this.db.prepare("SELECT ref, agent, origin FROM vault_member_copies WHERE owner = ?" + (q.item ? " AND item_h = ?" : "") + (q.agent ? " AND agent = ?" : "") + (q.origin ? " AND origin = ?" : ""))
      .all(...[q.owner, q.item ? MemberCopies.itemHash(q.owner, q.item) : undefined, q.agent, q.origin].filter(x => x !== undefined)));
  }

  /** What a member has shared: reference, agent, site, expiry, and her name for the login. Metadata only. @param {string} owner */
  async ofOwner(owner) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT ref, agent, origin, expires FROM vault_member_copies WHERE owner = ? AND gone = 0 ORDER BY at").all(String(owner))).filter(r => Number(r.expires) > this.v.clock());
    return Promise.all(rows.map(async r => ({ ref: String(r.ref), item: await this.label(String(r.ref), String(owner)), agent: String(r.agent), origin: String(r.origin), expires: Number(r.expires) })));
  }

  /** The logins an agent may use from members, as the agent is told of them: a reference and the member's label, never a value. @param {string} uid */
  async forAgent(uid) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT ref, owner, origin, expires FROM vault_member_copies WHERE uid = ? AND gone = 0").all(String(uid))).filter(r => Number(r.expires) > this.v.clock());
    return Promise.all(rows.map(async r => ({ ref: String(r.ref), label: await this.label(String(r.ref), String(r.owner)), origin: String(r.origin) })));
  }

  /** Delete what has expired, and try again what could not be reached. @returns {Promise<number>} */
  async sweep() {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT ref FROM vault_member_copies WHERE expires <= ? OR gone = 1").all(this.v.clock()));
    for (const r of rows) await this.remove(r.ref);
    return rows.length;
  }
}
