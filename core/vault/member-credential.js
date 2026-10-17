// @ts-check
// member-credential: a member lends one of her own API credentials to one chat's agent for one turn (tagging it in the chat). It is the API-key half of the turn lend; member-share.js is the login half.
//
// What the server holds: a copy of the credential (hosts, how it signs, the key) in the member's OWN vault, in the folder of what she lends, sealed under her lend key (PeopleVaults.lent), and a kernel grant
// on that copy's address (vault.read and vault.call, for that agent, only in that chat, until an expiry). The agent is told only the copy's opaque name. It calls through vault.request with that name; the key is
// added at the home, only to the credential's own hosts (the same plan, redirect and host rules every credential has), and is never in what the agent gets back. The owner's credentials are not reachable here:
// this store knows only copies of members' own. The copy and the grant live and die together: the turn ending (endFor), the expiry, the member changing the credential or leaving deletes both.

import crypto from "node:crypto";
import { connectionUrn } from "./connection-token.js";
import { normalize } from "./api-request.js";

export const SOURCE = "vault:member-credential";
const HOUR = 3_600_000, DAY = 86_400_000;
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const sha = (/** @type {string[]} */ ...p) => crypto.createHash("sha256").update(p.join("\0")).digest("hex");
/** A key a copy can carry and keep: a header, a bearer token or basic credentials that live in the credential itself. A sign-in that refreshes, a browser site, a service account or a named vault item stays where it is. */
const KEPT = new Set(["bearer", "api-key", "basic"]);
export const NAME = /^lent-[0-9a-f]{16}$/;

/** Read a member's credential item as the request path wants it, or throw why it cannot be lent. @param {any} item */
export function parseCredential(item) {
  if (!item || item.kind !== "api-credential") throw bad("only an API credential is lent this way");
  const f = item.fields || {};
  let config;
  try { config = normalize(JSON.parse(String(f.config || ""))); } catch (e) { throw bad(`that credential cannot be lent: ${String(/** @type {Error} */ (e).message).slice(0, 120)}`); }
  if (!KEPT.has(config.auth.type) || config.auth.item || config.app || !f.secret) throw bad("only a key kept in the credential itself can be lent: not a sign-in, a browser site or a key kept in another item");
  return { config, config_json: String(f.config), secret: String(f.secret) };
}

export class MemberCredential {
  /** @param {import("./access.js").Access} access @param {any} people the member vaults (PeopleVaults) */
  constructor(access, people) {
    this.access = access; this.people = people; this.db = access.v.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_member_creds (
      ref TEXT PRIMARY KEY, owner TEXT NOT NULL, item_h TEXT NOT NULL, agent TEXT NOT NULL, uid TEXT NOT NULL, thread TEXT NOT NULL, expires INTEGER NOT NULL, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0
    )`);
  }
  get K() { return this.access.need(); }
  clock() { return this.access.v.clock(); }
  static ref(/** @type {string} */ owner, /** @type {string} */ item, /** @type {string} */ agent, /** @type {string} */ thread) { return "lent-" + sha("cred", owner, item, agent, thread).slice(0, 16); }
  static itemHash(/** @type {string} */ owner, /** @type {string} */ item) { return sha("item", owner, item).slice(0, 32); }

  /**
   * Lend one of her own API credentials to one chat's agent for that chat's turn. The person is GIVEN (the Switchboard checked she is in the chat and the agent is the chat's, and her presence was asked once).
   * @param {string} owner @param {{ item: string, agent: string, thread: string, expires?: number }} i @returns {Promise<{ credential: string, agent: string, expires: number }>}
   */
  async lend(owner, i) {
    if (typeof owner !== "string" || !/^per_[A-Za-z0-9_-]{1,64}$/.test(owner) || owner === String(this.K.owner)) throw bad("a loan is a member's own credential", "denied");
    const thread = String(i.thread || "");
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(thread)) throw bad("a loan is for one chat");
    const agent = String(i.agent || "").toLowerCase();
    if (!agent || agent === "assistant") throw bad("name one of your agents; the default assistant takes no loan", "bad_input");
    const now = this.clock(), expires = i.expires === undefined ? now + HOUR : Number(i.expires);
    if (!(expires > now) || expires > now + DAY) throw bad("a loan to a chat ends within a day");
    const uid = await this.access.uidOf(agent);
    if (!uid) throw bad(`no agent named ${agent.slice(0, 60)}`, "not_found");
    await this.sweep();
    let it;
    try { it = await this.people.get(owner, { name: String(i.item || "") }); } catch (e) { if (/** @type {any} */ (e).code === "not_found") throw bad(`no item of yours named ${String(i.item || "").slice(0, 60)}`, "not_found"); throw e; }
    const c = parseCredential(it);
    const ref = MemberCredential.ref(owner, String(i.item), agent, thread);
    await this.people.lent(owner).put(ref, { kind: "api-credential", description: String(i.item), fields: { config: c.config_json, secret: c.secret } });
    this.db.prepare(`INSERT INTO vault_member_creds (ref, owner, item_h, agent, uid, thread, expires, at, gone) VALUES (?,?,?,?,?,?,?,?,0)
      ON CONFLICT(ref) DO UPDATE SET expires = excluded.expires, at = excluded.at, uid = excluded.uid, gone = 0`).run(ref, owner, MemberCredential.itemHash(owner, String(i.item)), agent, uid, thread, expires, now);
    try {
      const K = this.K;
      await K.mint.end({ source: `${SOURCE}:${ref}`, reason: "lent again" });
      await K.mint.make({ subject: { kind: "actor", actor: { kind: "agent", id: uid, space: K.space } }, actions: ["vault.read", "vault.call"], resource: { prefix: connectionUrn(K.space, owner, ref) },
        conditions: { where: { sessions: [thread] }, when: { expires } }, source: `${SOURCE}:${ref}`, reason: "a member lent an API credential to this chat's agent for the turn" });
    } catch (e) { await this.remove(ref); throw e; }
    this.access.v.audit("member-lend", ref, `person:${owner}`, true, `agent:${agent}`, { kind: "api-credential" });
    this.access.v.emit("vault.member-lent", { ref, agent, kind: "api-credential" });
    return { credential: ref, agent, expires };
  }

  /** The row of a live copy, or null: not a lent name, gone, or past its expiry (then its deletion starts here). @param {string} ref */
  find(ref) {
    if (!NAME.test(String(ref))) return null;
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_member_creds WHERE ref = ?").get(String(ref)));
    if (!r || r.gone) return null;
    if (Number(r.expires) <= this.clock()) { void this.remove(r.ref); return null; }
    return { ref: String(r.ref), owner: String(r.owner), agent: String(r.agent), uid: String(r.uid), thread: String(r.thread), expires: Number(r.expires) };
  }

  /** The credential, for the request path only: opened with the member's lend key. Null for any name that is not a live copy. @param {string} ref */
  async credential(ref) {
    const c = this.find(ref);
    if (!c) return null;
    const it = await this.people.lent(c.owner).get(c.ref);
    return { row: { name: c.ref, ver: 0 }, config: normalize(JSON.parse(String(it.fields.config))), secret: String(it.fields.secret) };
  }

  /** May this agent use this copy in this chat, for this action: the kernel's grant, asked every time. @param {string} ref @param {string} agent @param {string} action @param {string} [thread] @returns {Promise<string>} allow, ask or deny */
  async effect(ref, agent, action, thread) {
    const c = this.find(ref), K = this.access.K;
    if (!c || !K || typeof K.agentMay !== "function" || c.thread !== thread || c.agent !== String(agent).toLowerCase()) return "deny";
    try { return String(await K.agentMay(c.uid, action, connectionUrn(K.space, c.owner, c.ref), undefined, true, thread)); } catch { return "deny"; }
  }

  /** Take back what one chat's turn was lent: the grants, then the copies. @param {string} owner @param {string} thread @returns {Promise<number>} */
  async endFor(owner, thread) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT ref, agent FROM vault_member_creds WHERE owner = ? AND thread = ?").all(owner, String(thread)));
    for (const r of rows) {
      try { await this.K.mint.end({ source: `${SOURCE}:${r.ref}`, reason: "the turn ended" }); } catch { /* an older end took it */ }
      await this.remove(String(r.ref));
      this.access.v.audit("member-unshare", String(r.ref), `person:${owner}`, true, `agent:${r.agent}`, { why: "the turn ended" });
      this.access.v.emit("vault.member-unshared", { ref: String(r.ref), agent: String(r.agent), why: "the turn ended" });
    }
    return rows.length;
  }

  /** The member left or changed the credential: everything lent of hers goes. @param {string} owner */
  async gone(owner) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT DISTINCT thread FROM vault_member_creds WHERE owner = ?").all(owner));
    let n = 0; for (const r of rows) n += await this.endFor(owner, String(r.thread));
    return n;
  }

  /** The member changed or removed a credential of hers: every copy of it is deleted (a new loan takes the new one). @param {string} owner @param {string} item */
  async changed(owner, item) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT DISTINCT thread FROM vault_member_creds WHERE owner = ? AND item_h = ?").all(owner, MemberCredential.itemHash(owner, item)));
    let n = 0;
    for (const r of rows) {
      const m = /** @type {any[]} */ (this.db.prepare("SELECT ref FROM vault_member_creds WHERE owner = ? AND item_h = ? AND thread = ?").all(owner, MemberCredential.itemHash(owner, item), String(r.thread)));
      for (const x of m) { try { await this.K.mint.end({ source: `${SOURCE}:${x.ref}`, reason: "the credential changed" }); } catch { /* ended */ } await this.remove(String(x.ref)); n++; }
    }
    return n;
  }

  /** Delete one copy: the sealed file, then the row; if the file cannot be reached now the row stays marked gone and never used, and a sweep tries again. @param {string} ref */
  async remove(ref) {
    const r = /** @type {any} */ (this.db.prepare("SELECT owner FROM vault_member_creds WHERE ref = ?").get(String(ref)));
    if (!r) return;
    this.db.prepare("UPDATE vault_member_creds SET gone = 1 WHERE ref = ?").run(String(ref));
    try { await this.people.lent(String(r.owner)).remove(String(ref)); this.db.prepare("DELETE FROM vault_member_creds WHERE ref = ?").run(String(ref)); }
    catch (e) { if (/** @type {any} */ (e).code === "not_found") this.db.prepare("DELETE FROM vault_member_creds WHERE ref = ?").run(String(ref)); }
  }

  async sweep() {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT ref FROM vault_member_creds WHERE expires <= ? OR gone = 1").all(this.clock()));
    for (const r of rows) await this.remove(String(r.ref));
    return rows.length;
  }
}
