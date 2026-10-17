// @ts-check
// member-share: a member shares one of their own logins with one agent, at Fill in, so the agent's Chrome can sign in while the member is away (V3a).
//
// What the server then holds: a copy of that one login in the member's OWN vault, in the folder of what she lends, sealed under her lend key (PeopleVaults.lent: the server opens that key and nothing else of hers;
// member-copies.js keeps only the record that finds and ends it), bound to a kernel grant (vault.fill on the copy's address, at one origin, until an expiry). The grant is made by the vault module; the copy is opened only by agentFill. The copy and the grant live and die together: unshare, expiry, the member changing the login, or the member leaving deletes the copy (and ends the grant);
// a copy whose grant is gone is not used (allowedCopy asks the kernel every time).
//
// Only the member, alone in the call's chain (no assistant acting for them, not the owner), explicitly, for a login of their own vault, at an origin they name, for an agent that exists and is not the default
// assistant. Nothing returned or recorded names the login: the audit and the events carry the opaque reference, the agent and the origin.

import { exactOrigin } from "./agents.js";
import { connectionUrn } from "./connection-token.js";
import { memberOf } from "./tools/me.js";
import { MemberCopies } from "./member-copies.js";

export const SOURCE = "vault:member-share";
const DAY = 86_400_000;
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
export const NOTICE = "Your agent can use this login while you're away.";

export class MemberShare {
  /** @param {import("./access.js").Access} access */
  constructor(access) { this.access = access; /** @type {any} */ this.people = null; this.copies = new MemberCopies(access.v, () => this.people); }

  get K() { return this.access.need(); }
  clock() { return this.access.v.clock(); }

  /** The grant that keeps a copy usable: the agent, vault.fill, the copy's own address, one origin, until the expiry. @param {{ ref: string, owner: string, uid: string, origin: string, expires: number }} c */
  async grant(c) {
    const K = this.K;
    await K.mint.end({ source: `${SOURCE}:${c.ref}`, reason: "shared again" });
    return K.mint.make({ subject: { kind: "actor", actor: { kind: "agent", id: c.uid, space: K.space } }, actions: ["vault.fill"], resource: { prefix: connectionUrn(K.space, c.owner, c.ref) }, conditions: { where: { origins: [c.origin] }, when: { expires: c.expires } }, source: `${SOURCE}:${c.ref}`, reason: "a member shared a login with this agent" });
  }

  /**
   * Share a login of the caller's own vault with an agent. @param {{ item: string, agent: string, origin: string, expires?: number }} i @param {any} meta
   */
  async share(i, meta) {
    const K = this.K, owner = await memberOf(K, meta), v = this.access.v, now = this.clock();
    if (!this.people) throw bad("the member vaults are not running", "unavailable");
    const origin = exactOrigin(i.origin);
    if (!origin) throw bad("name the site the agent may sign in to, as an address such as https://app.example.com");
    const expires = i.expires === undefined ? now + 7 * DAY : Number(i.expires);
    if (!(expires > now) || expires > now + 366 * DAY) throw bad("a share ends in the future and within a year");
    const agent = String(i.agent || "").toLowerCase();
    if (!agent || agent === "assistant") throw bad("name one of your agents; the default assistant takes no shared login", "bad_input");
    // Only an agent she may instruct herself (she made it, or was given Can use or Can edit): a login put into an agent others also instruct is filled for whoever instructs it. Anything else is not found.
    const who = await this.access.ctx.call("agents.instructors", { agent });
    if (who.error || !who.data) throw bad(`no agent named ${agent.slice(0, 60)}`, "not_found");
    const others = [...new Set([who.data.made_by, ...(Array.isArray(who.data.shares) ? who.data.shares : [])].filter((/** @type {any} */ x) => typeof x === "string" && x && x !== owner))];
    const uid = await this.access.uidOf(agent);
    if (!uid) throw bad(`no agent named ${agent.slice(0, 60)}`, "not_found");
    await this.copies.sweep();
    // Open the login in the member's own vault: this needs them unlocked, which is why the copy exists at all.
    const it = await this.people.get(owner, { name: String(i.item || "") });
    const f = it.fields || {};
    if (it.kind !== "login" || !f.password) throw bad("only a login with a password can be shared with an agent", "bad_input");
    const ref = await this.copies.put({ owner, item: String(i.item), agent, uid, origin, expires, fields: f });
    try { await this.grant({ ref, owner, uid, origin, expires }); } catch (e) { await this.copies.remove(ref); throw e; }
    v.audit("member-share", ref, `person:${owner}`, true, `agent:${agent}`, { origin });
    v.emit("vault.member-shared", { ref, agent, origin });
    return { shared: { ref, item: String(i.item), agent, origin, expires }, notice: NOTICE, instructors: { others, staff: "the owner and the admins can instruct every agent" } };
  }

  /** End the member's shares of one login (all agents and origins, or those named). @param {{ item: string, agent?: string, origin?: string }} i @param {any} meta */
  async unshare(i, meta) {
    const owner = await memberOf(this.K, meta);
    const o = i.origin ? exactOrigin(i.origin) : undefined;
    if (i.origin && !o) throw bad("that is not an address");
    return { ended: await this.end({ owner, item: String(i.item || ""), ...(i.agent ? { agent: String(i.agent).toLowerCase() } : {}), ...(o ? { origin: o } : {}) }, "unshared") };
  }

  /** Delete the copies that match and end their grants. @param {{ owner: string, item?: string, agent?: string, origin?: string }} q @param {string} why @returns {Promise<number>} */
  async end(q, why) {
    const rows = this.copies.match(q);
    for (const r of rows) {
      try { await this.K.mint.end({ source: `${SOURCE}:${r.ref}`, reason: why }); } catch { /* an older end already took it */ }
      await this.copies.remove(r.ref);
      this.access.v.audit("member-unshare", r.ref, `person:${q.owner}`, true, `agent:${r.agent}`, { origin: r.origin, why });
      this.access.v.emit("vault.member-unshared", { ref: r.ref, agent: r.agent, origin: r.origin, why });
    }
    return rows.length;
  }

  /** What the member has shared: the login's name (it is their own), the agent, the site, the expiry. Never a value. @param {any} meta */
  async list(meta) {
    const owner = await memberOf(this.K, meta);
    await this.copies.sweep();
    return { shares: await this.copies.ofOwner(owner), notice: NOTICE };
  }

  /** May this agent sign in with this copy at this origin: the share's own live grant and the member still in the Space, asked every time. @param {{ ref: string, owner: string, uid: string, origin: string }} copy @param {string} origin */
  async allowedCopy(copy, origin) {
    const o = exactOrigin(origin), K = this.access.K;
    if (!K || !o || o !== copy.origin) return false;
    try {
      // The kernel's whole answer for this agent first (it is still a registered agent of the Space, no deny or freeze on it, the member-narrowing and group rules), asked for the chain [the member, the agent]: the grant is the
      // member's own (source vault:member-share:<ref>), so the member's side must hold it, not the Space owner's. The answer is yes only when it AND the share both say yes.
      // Where the kernel handle has no agentMay (a bare test rig) the share checks alone decide.
      if (typeof K.agentMay === "function" && !(await K.agentMay(copy.uid, "vault.fill", connectionUrn(K.space, copy.owner, copy.ref), o, false, undefined, copy.owner))) return false;
      // The share is the grant (no per-conversation lend): the copy is live (find() already drops an expired or removed one), and the grant the share made for exactly this agent and site has not been taken back or
      // run out (the vault module made it and lists it by its source; only active, unexpired grants are listed).
      const live = (await K.mint.list({ source: `${SOURCE}:${copy.ref}` })) || [];
      const grantOk = live.some((/** @type {any} */ g) => g && g.subject && g.subject.actor && String(g.subject.actor.id) === String(copy.uid) && Array.isArray(g.actions) && g.actions.includes("vault.fill")
        && g.conditions && g.conditions.where && Array.isArray(g.conditions.where.origins) && g.conditions.where.origins.includes(o));
      if (!grantOk) return false;
      return await this.memberStill(K, copy.owner);
    } catch { return false; }
  }

  /** Whether the member is still in the Space: the kernel's own membership question where the handle has it, else the member list read under the home's own chain (K.chain({}) with no call is the module's service chain). @param {any} K @param {string} person */
  async memberStill(K, person) {
    if (typeof K.membership === "function") return Boolean(await K.membership(person));
    const ms = K.grants && K.grants.members ? await K.grants.members.list(await K.chain({})) : null;
    return Array.isArray(ms) && ms.some((/** @type {any} */ m) => String(m.person) === String(person));
  }

  /**
   * She can no longer instruct this agent (its sharing with her was taken back): her shares with it end, and with them the grants and the copies. Staff (owner, admin) instruct every agent, so nothing ends for
   * them. A share is only valid for an agent she may instruct, and that can change after the share.
   * @param {string} owner @param {string} agent the agent's name @returns {Promise<number>}
   */
  async agentLost(owner, agent) {
    const K = this.access.K;
    if (!K) return 0;
    let role = null;
    try { role = typeof K.membership === "function" ? await K.membership(owner) : null; } catch { role = null; }
    const name = role && typeof role === "object" ? role.role : role;
    if (name === "owner" || name === "admin") return 0;
    return this.end({ owner, agent: String(agent).toLowerCase() }, "you can no longer instruct the agent");
  }

  /** The member changed or removed a login of theirs: every copy of it is refreshed from the new one, or deleted if it is gone or no longer a login with a password. @param {string} owner @param {string} item */
  async changed(owner, item) {
    const rows = this.copies.match({ owner, item });
    if (!rows.length || !this.people) return 0;
    // Fail closed: a copy that cannot be brought up to date with the login it was taken from is deleted, with its grant, never kept as it was.
    try {
      let it = null;
      try { it = await this.people.get(owner, { name: item }); } catch (e) { if (/** @type {any} */ (e).code === "locked") throw e; it = null; }
      const f = it && it.kind === "login" && it.fields && it.fields.password ? it.fields : null;
      if (!f) return await this.end({ owner, item }, "the login was removed or is no longer a login");
      for (const r of rows) { const m = /** @type {any} */ (this.copies.find(r.ref)); if (m) await this.copies.put({ owner, item, agent: m.agent, uid: m.uid, origin: m.origin, expires: m.expires, fields: f }); }
      return 0;
    } catch (e) {
      await this.end({ owner, item }, "the copy could not be brought up to date");
      throw e;
    }
  }

  /** The member left (removed or expired): everything they shared goes. @param {string} owner */
  async gone(owner) { return this.end({ owner }, "the member left"); }
}
