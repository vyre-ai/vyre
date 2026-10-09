// @ts-check
// core/vault/access.js: who may use a login, on the one grant model (team/0.3.1/DESIGN-one-grant.md). Lending a login to an agent is a kernel grant: the agent, `vault.fill` on the item's
// address in the owner's personal vault, at one exact origin, until an expiry. The vault keeps no table of who may use what. What it keeps here is a request an assistant made and a person has
// not answered yet (it carries no authority until a person approves it), and the one-time carrying over of the agent logins an older vault stored itself.
//
// Taking access away never needs anyone (the kernel lets the vault module end its own grants, see grants `takeBack`); giving it is the person's own act, through the kernel with their chain.

import { newPrefixedId } from "../../lib/id.js";
import { asPerson, ensureAgent } from "../../lib/project-reach.js";
import { exactOrigin } from "./agents.js";
import { hostsOf } from "./native.js";

/** Requests an assistant made, waiting for a person (vault.pending, vault.approve). Appended to the vault's MIGRATIONS. */
export const ACCESS_REQUESTS_MIGRATION = `CREATE TABLE vault_access_requests (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, by TEXT, at INTEGER NOT NULL, UNIQUE (item, agent, origin)
   );`;

const SOURCE = "vault:agent";

export class Access {
  /** @param {import("./vault.js").Vault} vault @param {any} ctx the vault module's ctx */
  constructor(vault, ctx) { this.v = vault; this.ctx = ctx; this.db = vault.db; /** @type {string | null} */ this.vid = null; this.carried = false; }

  /** The kernel's side of the vault, or null in a build with no kernel (then no login is lent to an agent). */
  get K() { const k = this.ctx && this.ctx.kernel; return k && k.grants && k.vault ? k : null; }
  need() { const k = this.K; if (!k) throw Object.assign(new Error("lending a login to an agent is a kernel grant, and this build has no kernel"), { code: "unavailable" }); return k; }

  /** The address of an item: under the owner's personal vault, whichever of the vault's two stores holds it now. */
  async urn(/** @type {string} */ name) {
    const K = this.need();
    if (!this.vid) this.vid = await K.vault.personalVault();
    return `vyre://${K.space}/vault/${this.vid}/item/${name}`;
  }

  /** An agent's stable id (the kernel's grants name it, never the name), or null for an agent that does not exist. @param {string} name */
  async uidOf(name) {
    const r = await this.ctx.call("agents.uid", { name: String(name).toLowerCase() });
    if (r && r.error && r.error.code !== "not_found") throw Object.assign(new Error(`agents cannot be asked yet: ${r.error.message}`), { code: "unavailable" });
    return r && r.data ? String(r.data.uid) : null;
  }
  /** @param {string} uid */
  async nameOf(uid) { const r = await this.ctx.call("agents.uid", { uid }); return r && r.data && r.data.name ? String(r.data.name) : uid; }

  /** A kernel grant as the tools show it: names, the origin and the expiry, never a value. */
  async out(/** @type {any} */ g) {
    const t = this.v.clock();
    const item = String(g.resource.prefix).split("/item/")[1];
    const exp = g.conditions && g.conditions.when ? g.conditions.when.expires : null;
    const status = g.status === "revoked" ? "revoked" : exp != null && exp <= t ? "expired" : "active";
    return { id: g.id, agent: await this.nameOf(String(g.subject.actor.id)), item, origin: g.conditions.where.origins[0], expires: exp ?? null, status };
  }

  /**
   * Lend a login, or ask for it. A person's lending is the kernel grant at once; an assistant's waits as a request until a person approves it (vault.approve).
   * @param {{ agent: string, item: string, origin: string, expires: number }} g @param {any} meta the call @param {boolean} pending
   */
  async lend({ agent, item, origin, expires }, meta, pending) {
    await this.v.key();
    const { r, o } = this.v.agents.check({ agent, item, origin });
    const t = this.v.clock(), caller = String(meta.caller);
    if (expires <= t) throw new Error("that expiry is in the past");
    if (pending) {
      const old = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_access_requests WHERE item=? AND agent=? AND origin=?").get(r.name, agent, o));
      const id = old ? old.id : newPrefixedId("ag");
      if (!old) this.db.prepare("INSERT INTO vault_access_requests (id, item, agent, origin, expires, by, at) VALUES (?,?,?,?,?,?,?)").run(id, r.name, agent, o, expires, caller, t);
      this.v.audit("agent-grant-requested", r.name, caller, true, `agent:${agent}`, { origin: o });
      this.v.emit("grant.requested", { agent, item: r.name, origin: o });
      return { grant: { id, agent, item: r.name, origin: o, expires, status: "pending" } };
    }
    const K = this.need(), uid = await this.uidOf(agent);
    if (!uid) throw new Error(`no agent named ${agent}`);
    const { chain, proof } = await asPerson(K, meta);
    await this.carry();
    const res = await this.urn(r.name);
    await ensureAgent(K, meta, uid);
    const before = await this.live(chain, { uid, res, origin: o });
    // The agent's computer is filled while nobody is here, so a lent login lives in the agent vault.
    if (r.vault === "personal") await this.v.reseal(r, "agents");
    // The items in this vault are the Space owner's: an owner or an admin gives an assistant access to them on their own authenticated call, and nobody else can.
    const made = await K.grants.create(chain, { subject: { kind: "actor", actor: { kind: "agent", id: uid, space: K.space } }, actions: ["vault.fill"], resource: { prefix: res }, conditions: { where: { origins: [o] }, when: { expires } }, source: SOURCE }, proof);
    // The same login at the same origin for the same agent is one grant: lending again replaces it (a new expiry).
    for (const g of before) await K.vault.takeBack({ id: g.id, reason: "lent again" });
    this.db.prepare("DELETE FROM vault_access_requests WHERE item=? AND agent=? AND origin=?").run(r.name, agent, o);
    this.v.audit("agent-grant", r.name, caller, true, `agent:${agent}`, { origin: o });
    this.v.emit("vault.agent-granted", { agent, item: r.name, origin: o });
    return { grant: await this.out(made) };
  }

  /** The live kernel grants lending a login: all of them, or those for one agent, address and origin. @param {any} chain @param {{ uid?: string, res?: string, origin?: string }} [f] */
  async live(chain, f = {}) {
    const all = await this.need().grants.list(chain, {});
    return all.filter((/** @type {any} */ g) => g.status === "active" && g.source === SOURCE && (!f.uid || g.subject.actor.id === f.uid) && (!f.res || g.resource.prefix === f.res) && (!f.origin || g.conditions.where.origins[0] === f.origin));
  }

  /** Requests waiting for a person, for vault.pending. */
  pending() {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_access_requests ORDER BY at").all()).map(g => ({ id: g.id, agent: g.agent, item: g.item, origin: g.origin, expires: g.expires, status: "pending", by: g.by, at: g.at }));
  }

  /** Approve a request (vault.approve with an ag_ id): the person's own lending of exactly what was asked. Null when there is none. */
  async approve(/** @type {string} */ id, /** @type {any} */ meta) {
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_access_requests WHERE id=?").get(id));
    if (!g) return null;
    if (g.expires <= this.v.clock()) throw new Error(`agent grant ${id} expired before it was approved; ask again`);
    const { grant } = await this.lend({ agent: g.agent, item: g.item, origin: g.origin, expires: g.expires }, meta, false);
    return { approved: grant };
  }

  /** Take one lending away, or turn down a request. Always allowed, for anyone, even a row the kernel no longer lists. */
  async revoke(/** @type {{ id: string }} */ { id }, /** @type {string} */ caller) {
    const req = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_access_requests WHERE id=?").get(String(id ?? "")));
    if (req) {
      this.db.prepare("DELETE FROM vault_access_requests WHERE id=?").run(req.id);
      this.v.audit("agent-revoke", req.item, caller, true, `agent:${req.agent}`, { origin: req.origin });
      return { revoked: true, grant: { id: req.id, agent: req.agent, item: req.item, origin: req.origin, expires: req.expires, status: "revoked" } };
    }
    const gone = await this.need().vault.takeBack({ id: String(id ?? ""), reason: "taken back" });
    if (!gone.length) throw new Error(`no agent grant ${id}`);
    const g = await this.out(gone[0]);
    this.v.audit("agent-revoke", g.item, caller, true, `agent:${g.agent}`, { origin: g.origin });
    this.v.emit("vault.agent-revoked", { agent: g.agent, item: g.item, origin: g.origin });
    return { revoked: true, grant: g };
  }

  /** Every lending of an item goes when the item goes. */
  async revokeItem(/** @type {string} */ item, /** @type {string} */ caller) {
    this.db.prepare("DELETE FROM vault_access_requests WHERE item=?").run(item);
    if (!this.K) return 0;
    const gone = await this.K.vault.takeBack({ prefix: await this.urn(item), reason: "the login was deleted" });
    for (const x of gone) { const g = await this.out(x); this.v.audit("agent-revoke", item, caller, true, `agent:${g.agent}`, { origin: g.origin }); this.v.emit("vault.agent-revoked", { agent: g.agent, item, origin: g.origin }); }
    return gone.length;
  }

  /** Lendings and requests, newest first, with the last use and a use count. Names only. @param {{ agent?: string, item?: string }} q @param {any} meta */
  async list({ agent, item } = {}, meta = {}) {
    await this.carry();
    const K = this.need();
    const { chain } = await asPerson(K, meta);
    const grants = await Promise.all((await K.grants.list(chain, {})).filter((/** @type {any} */ g) => g.source === SOURCE).map((/** @type {any} */ g) => this.out(g)));
    const rows = [...grants, ...this.pending().map(p => ({ ...p, by: undefined }))].filter(g => (!agent || g.agent === agent) && (!item || g.item === item));
    const use = this.db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM vault_audit WHERE action='agent-fill' AND ok=1 AND name=? AND who=? AND origin=?");
    return { grants: rows.map(g => { const u = /** @type {any} */ (use.get(g.item, `agent:${g.agent}`, g.origin)); return { ...g, lastUsed: u.last ?? null, uses: Number(u.n) }; }) };
  }

  /** The logins this agent may use, and where: asked of the kernel one login and one host at a time, so an agent sees its own and nobody else's. @param {string} agent */
  async usable(agent) {
    const out = [];
    for (const it of this.v.list().items) if (it.kind === "login") for (const h of it.hosts) if (await this.allowed(agent, it.name, h)) out.push({ item: it.name, origin: h });
    return { grants: out };
  }

  /** May this agent sign in with this login at this origin? Asked of the kernel, which holds the grant: unexpired, not taken back, this origin exactly. */
  async allowed(/** @type {string} */ agent, /** @type {string} */ item, /** @type {string} */ origin) {
    const K = this.K, o = exactOrigin(origin);
    if (!K || !o || typeof K.agentMay !== "function") return false;
    const r = this.v.row(String(item));
    if (!r || r.kind !== "login" || !hostsOf(r).includes(o)) return false;
    const uid = await this.uidOf(agent);
    return uid ? K.agentMay(uid, "vault.fill", await this.urn(r.name), o) : false;
  }

  /**
   * Carry over the agent logins the vault stored itself before the one grant model: each row that passes its check becomes the kernel grant it always was (same agent, login, origin and expiry),
   * a row that fails its check is dropped (it was ignored before), and the table is emptied. Once per start; a locked vault tries again at the next call.
   */
  async carry() {
    const K = this.K;
    if (this.carried || !K) return;
    // No older rows, no key needed: starting the vault makes none.
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE status='active' AND revoked IS NULL").all());
    if (rows.length) try { await this.v.key(); } catch { return; }
    if (rows.length) {
      const send = [];
      // Agents not answering yet (they start after the vault) leaves the rows where they are for the next call; an agent that is gone, or a row that fails its check, is dropped.
      try { for (const g of rows) { const uid = this.v.rowOk("vault_agent_grants", g) ? await this.uidOf(g.agent) : null; if (uid) send.push({ id: g.id, who: uid, item: g.item, origin: g.origin, expires: g.expires }); } } catch { return; }
      await K.vault.carryOver(send);
      this.v.emit("vault.agent-carried", { rows: rows.length, carried: send.length });
    }
    this.db.prepare("DELETE FROM vault_agent_grants").run();
    this.carried = true;
  }
}
