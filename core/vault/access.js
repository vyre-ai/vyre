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
import { credentialUrn } from "../../kernel/contracts/index.js";

/** Requests an assistant made, waiting for a person (vault.pending, vault.approve). Appended to the vault's MIGRATIONS. */
export const ACCESS_REQUESTS_MIGRATION = `CREATE TABLE vault_access_requests (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, by TEXT, at INTEGER NOT NULL, UNIQUE (item, agent, origin)
   );`;

/** What was converted once, by key (a credential's scope): so a conversion is made and logged once. Appended to the vault's MIGRATIONS. */
export const CONVERSIONS_MIGRATION = `CREATE TABLE vault_conversions (key TEXT PRIMARY KEY, at INTEGER NOT NULL, note TEXT);`;

const SOURCE = "vault:agent";

export class Access {
  /** @param {import("./vault.js").Vault} vault @param {any} ctx the vault module's ctx */
  constructor(vault, ctx) { this.v = vault; this.ctx = ctx; this.db = vault.db; /** @type {string | null} */ this.vid = null; this.carried = false; /** @type {Promise<void> | null} */ this.converting = null; }

  /** The kernel's side of the vault, or null in a build with no kernel (then no login is lent to an agent). */
  get K() { const k = this.ctx && this.ctx.kernel; return k && k.grants && k.vault ? k : null; }
  need() { const k = this.K; if (!k) throw Object.assign(new Error("lending a login to an agent is a kernel grant, and this build has no kernel: ask the owner to update Vyre to a build that has one"), { code: "unavailable" }); return k; }

  /** The address of an item: under the owner's personal vault, whichever of the vault's two stores holds it now. */
  async urn(/** @type {string} */ name) {
    const K = this.need();
    if (!this.vid) this.vid = await K.vault.personalVault();
    return `vyre://${K.space}/vault/${this.vid}/item/${name}`;
  }

  /** An agent's stable id (the kernel's grants name it, never the name), or null for an agent that does not exist. @param {string} name */
  async uidOf(name) {
    const r = await this.ctx.call("agents.uid", { name: String(name).toLowerCase() });
    if (r && r.error && r.error.code !== "not_found") throw Object.assign(new Error(`agents cannot be asked yet: ${r.error.message} (wait a minute and call again)`), { code: "unavailable" });
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

  /** The names of the logins lent to an agent right now, read live from the kernel (none without one). @returns {string[]} */
  items() {
    const K = this.K;
    if (!K) return [];
    const t = this.v.clock();
    return K.vault.grantsOn(`vyre://${K.space}/vault/`).filter((/** @type {any} */ g) => g.source === SOURCE && !(g.conditions && g.conditions.when && g.conditions.when.expires <= t)).map((/** @type {any} */ g) => String(g.resource.prefix).split("/item/")[1]);
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

  /**
   * May this deployment have this item's value? Publish grants a deployment its secret as a kernel grant (`vault.run` on the credential's address, to the deployment's own service actor, source
   * `publish:secret:<deployment>:...`); the Vault releases to Publish for that deployment only while the grant is live, so one key can serve many deployments and the chat's own use, each on its own.
   * @param {string} name the item @param {string} deployment
   */
  deploymentMay(name, deployment) {
    const K = this.K;
    if (!K || !/^[A-Za-z0-9_.-]{1,80}$/.test(String(deployment))) return false;
    const t = this.v.clock(), at = credentialUrn(K.space, name);
    return K.vault.grantsOn(at).some((/** @type {any} */ g) => g.resource.prefix === at && g.actions.includes("vault.run") && g.source.startsWith(`publish:secret:${deployment}:`)
      && g.subject.actor && g.subject.actor.id === `deployment-${deployment}` && !(g.conditions && g.conditions.when && g.conditions.when.expires <= t));
  }

  /** Every deployment's use of a credential goes when the item goes. @param {string} item */
  async revokeDeployments(item) {
    const K = this.K;
    return K ? (await K.vault.takeBack({ prefix: credentialUrn(K.space, item), reason: "the credential was deleted" })).length : 0;
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

  /**
   * A task credential lease (team/BACKLOG.md): the doer agent may use named Connections for one task. Its authority is the person's yes when the Kit was installed, which listed those credentials, so it is
   * bound to exactly that: flows says (`flows.kit.credentials`) which approved Kit version the task is from and which credentials it names; a Connection that is not named there, or does not exist, is refused.
   * Use only (a read runs, anything outward is still held), until `until` or `leaseEnd`, idempotent per task, agent and Connection, so a restart does not double it. The grant records the Kit and its version.
   * @param {{ task: string, agent: string, connections: string[], until: number }} i
   */
  async leaseTask({ task, agent, connections, until }) {
    const K = this.need();
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(task))) throw new Error("name the task");
    if (!Array.isArray(connections) || !connections.length || connections.length > 20) throw new Error("name the Connections to lend, up to 20");
    if (!(Number(until) > this.v.clock())) throw new Error("a lease ends in the future");
    const uid = await this.uidOf(agent);
    if (!uid) throw new Error(`no agent named ${agent}`);
    const k = await this.ctx.call("flows.kit.credentials", { task: String(task) });
    const kit = k && k.data;
    if (!kit || kit.approved !== true || typeof kit.kit !== "string" || !kit.version || !Array.isArray(kit.credentials)) throw Object.assign(new Error("no approved Kit version names credentials for that task (flows.kit.list shows the Kits; a person approves a version that names them)"), { code: "denied" });
    for (const c of connections) {
      if (!kit.credentials.includes(c)) throw Object.assign(new Error(`${String(c).slice(0, 60)} is not named by the task's Kit, so it cannot be lent: name it in the Kit and have a person approve that version (flows.kit.propose)`), { code: "denied" });
      const got = await this.ctx.call("connectors.connection.get", { id: String(c) });
      if (got.error) throw Object.assign(new Error(`no Connection ${String(c).slice(0, 60)} (connectors.connection.list shows them)`), { code: "not_found" });
    }
    const tag = `${String(kit.kit).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}@${String(kit.version).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 20)}`;
    const made = await K.vault.carryOver(connections.map(c => ({ id: `lease:${task}:${uid}:${c}:${tag}`, kind: "lease", task: String(task), who: uid, item: String(c), expires: Number(until) })));
    this.v.audit("lease-lent", null, "module:flows", true, `task ${task} to ${agent}: ${connections.join(", ")} (${tag})`);
    this.v.emit("vault.lease-lent", { task, agent, connections, kit: kit.kit, version: kit.version });
    return { lent: made.length, already: connections.length - made.length };
  }

  /** The task is over: every lease of it is taken back (or it ended by itself at its time). @param {{ task: string, reason?: string }} i */
  async leaseEnd({ task, reason }) {
    const K = this.need();
    const gone = await K.vault.takeBack({ source: `vault:lease:${String(task)}`, reason: String(reason || "the task ended").slice(0, 120) });
    this.v.audit("lease-ended", null, "module:flows", true, `task ${task}: ${gone.length} taken back`);
    this.v.emit("vault.lease-ended", { task, ended: gone.length });
    return { ended: gone.length };
  }

  /**
   * Which kernel agent a model call is: the agent it names, else the assistant. The kernel's own default assistant is a delegate of the person (it holds whatever the person holds), so a credential is asked
   * of the agent's STABLE ID (agents.uid), which is never a delegate: an agent or the assistant reaches a credential only through a grant of its own.
   * @param {{ agent?: string, agentKind?: string }} meta @param {string} caller
   */
  modelName(meta, caller) { return String(meta.agent || (/(?:^|:)agent:([^:\s]+)/.exec(caller) || [])[1] || "assistant").toLowerCase(); }

  /** The kernel's answer for a model to use a credential: "allow", "ask" (an outward act, held for a person) or "deny". An agent the Space does not know, or an unreachable kernel, is deny. */
  async effectFor(/** @type {string} */ name, /** @type {string} */ item, /** @type {string} */ action, /** @type {string} */ origin) {
    const K = this.K;
    if (!K || typeof K.agentMay !== "function") return "deny";
    try {
      await this.convertScopes();
      const uid = await this.uidOf(name);
      if (!uid) return "deny";
      // The credential's own address, and for a Connection's derived credential (`conn-<id>`) the Connection's: a task lease is a grant on the Connection.
      const at = [await this.urn(item)];
      const c = /^conn-([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(item);
      if (c) at.push(`${at[0].split("/item/")[0]}/connection/${c[1]}`);
      let best = "deny";
      for (const res of at) { const e = String(await K.agentMay(uid, action, res, origin, true)); if (e === "allow") return e; if (e === "ask") best = e; }
      return best;
    } catch { return "deny"; }
  }

  /**
   * The items a model holds a grant for, of any kind, by the same check a call makes: an API credential it may read, a login lent to it at one of its sites, an item it may read or take a code from.
   * Names and kinds (an API credential also its description and hosts), never a value. @param {string} name
   */
  async listFor(name) {
    const out = [];
    for (const it of this.v.list().items) {
      let ok = (await this.effectFor(name, it.name, "vault.read")) !== "deny" || (await this.effectFor(name, it.name, "vault.totp")) !== "deny";
      for (const h of ok ? [] : it.hosts || []) if ((await this.effectFor(name, it.name, "vault.fill", h)) !== "deny") { ok = true; break; }
      if (ok) out.push({ name: it.name, kind: it.kind, ...(it.kind === "api-credential" ? { ...(it.description ? { description: it.description } : {}), ...(it.hosts && it.hosts.length ? { hosts: it.hosts } : {}) } : {}) });
    }
    return out;
  }

  /**
   * The older way to reach a credential, its `scope` ({ projects, agents }) and the assistant's exemption, become kernel grants once per credential, and each conversion is logged (an audit row and an event naming
   * what was made): a named agent in the scope gets the credential; a scope that names projects and no agents gives it to each project (its people and agents, by project reach); a scope of everyone gives it to
   * every agent there is now; and the assistant gets every credential it could reach, so nothing that works today stops. After that a credential is reached by grants alone, and the scope in its config is ignored.
   */
  async convertScopes(quiet = false) {
    const K = this.K;
    if (!K || this.converting) return this.converting;
    return (this.converting = (async () => {
      try {
        // Starting the vault makes no key: with credentials to convert and the key not open, this waits for the first model call (which opens it).
        const have = Number(/** @type {any} */ (this.db.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE kind = 'api-credential'").get()).n);
        if (have && !this.v.vk && quiet) return;
        const names = have ? await this.v.apiCredentialNames() : [];
        const done = new Set(/** @type {any[]} */ (this.db.prepare("SELECT key FROM vault_conversions").all()).map(r => r.key));
        // Once for the whole vault: the credentials that exist when it first runs. A credential made after that is reached by grants alone, so a new one is never opened to the assistant by this.
        if (done.has("scope:all")) return;
        const todo = names.filter(n => !done.has(`scope:${n}`));
        if (!todo.length) { this.db.prepare("INSERT OR IGNORE INTO vault_conversions (key, at, note) VALUES (?,?,?)").run("scope:all", this.v.clock(), JSON.stringify({ credentials: 0 })); return; }
        const list = await this.ctx.call("agents.list", {});
        if (list.error) return; // agents are not running yet: try again at the next call
        /** @type {{ uid: string, name: string, kind?: string }[]} */ const agents = (Array.isArray(list.data) ? list.data : list.data && list.data.agents) || [];
        const assistant = agents.find(a => a.kind === "assistant");
        for (const item of todo) {
          let cfg; try { cfg = (await this.v.apiCredential(item)).config; } catch { continue; }
          const sc = cfg.scope, rows = /** @type {any[]} */ ([]), who = { agents: /** @type {string[]} */ ([]), projects: /** @type {string[]} */ ([]) };
          const add = (/** @type {string} */ w, /** @type {string} */ label, /** @type {string[]} */ into) => { rows.push({ id: `scope:${item}:${w}`, kind: "scope", who: w, item }); into.push(label); };
          if (sc) {
            const named = sc.agents === "*" ? agents.filter(a => a.kind !== "assistant") : agents.filter(a => sc.agents.includes(a.name));
            if (sc.projects === "*" || sc.agents !== "*") for (const a of named) add(a.uid, a.name, who.agents);
            else for (const slug of sc.projects) { const r = await this.ctx.call("projects.record", { project: slug }); const id = r && r.data && String(r.data.urn || "").split("/").pop(); if (id) add(`project:${id}`, slug, who.projects); }
          }
          if (assistant) add(assistant.uid, assistant.name, who.agents);
          await K.vault.carryOver(rows);
          this.db.prepare("INSERT OR IGNORE INTO vault_conversions (key, at, note) VALUES (?,?,?)").run(`scope:${item}`, this.v.clock(), JSON.stringify(who));
          this.v.audit("scope-converted", item, "vault", true, `agents ${who.agents.join(",") || "none"}; projects ${who.projects.join(",") || "none"}`);
          this.v.emit("vault.scope-converted", { item, agents: who.agents, projects: who.projects, ...(sc && sc.projects !== "*" && sc.agents !== "*" ? { note: "an agent in a named project keeps the credential in every project: narrow it with the project's reach" } : {}) });
        }
        this.db.prepare("INSERT OR IGNORE INTO vault_conversions (key, at, note) VALUES (?,?,?)").run("scope:all", this.v.clock(), JSON.stringify({ credentials: todo.length }));
      } finally { this.converting = null; }
    })());
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
