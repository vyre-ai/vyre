// @ts-check
// agent logins: one agent, one login, one origin (ADR 0028, decision 2), and the log of every use.
//
// An agent grant lets an agent sign in to one site as the person, through vyred's own fill of the
// agent's computer (decision 3, not built here). It never lets the agent read the login. Each row
// names exactly one agent, one login and one origin (scheme, host and port, compared exactly),
// is MACed like the module grants (vault.js MACED), and a row that fails its check is ignored.
// From Claude a grant waits as pending until a person approves it with vault.approve; revoking
// never needs anyone. Rows, events and audit lines carry names and origins, never a value or a
// username.

import { hostsOf } from "./native.js";
import { newPrefixedId } from "../../lib/id.js";

/** The vault_agent_grants table (vault.js appends it to MIGRATIONS). */
export const AGENT_GRANTS_MIGRATION = `CREATE TABLE vault_agent_grants (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER,
     status TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, revoked INTEGER, mac TEXT, UNIQUE (item, agent, origin)
   );
   CREATE INDEX vault_agent_grants_agent ON vault_agent_grants (agent, item);`;

/** Where an audit row came from, for vault.uses (nullable; older rows carry it in `why`). */
export const AUDIT_WHERE_MIGRATION = `ALTER TABLE vault_audit ADD COLUMN origin TEXT;
   ALTER TABLE vault_audit ADD COLUMN surface TEXT;`;

/** The MACed columns: what decides who may sign in where, and until when. */
export const AGENT_GRANT_MACED = ["id", "item", "agent", "origin", "expires", "status", "revoked"];

/** Audit actions that are a use of an item: a value went somewhere, or was asked to. */
export const USE_ACTIONS = ["fill", "agent-fill", "fill-native", "release", "relay", "totp", "copy", "reveal", "inject"];

/** The surfaces a use is recorded from (ADR 0028, decision 2). */
export const SURFACES = ["ios", "android", "mac", "chrome", "firefox", "capsule", "computer", "deck", "cli"];

/** Agent names as core/agents makes them. */
const AGENT = /^[a-z][a-z0-9-]{1,30}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const now = () => Date.now();
const newId = () => newPrefixedId("ag");

/** "1 Oct", or "1 Oct 2027" outside this year. @param {number} t */
export function day(t, from = now()) {
  const d = new Date(t);
  const y = d.getUTCFullYear() === new Date(from).getUTCFullYear() ? "" : ` ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${y}`;
}

/** An exact http(s) origin, or null when the text has a path, query, user or anything else. @param {unknown} o */
export function exactOrigin(o) {
  if (typeof o !== "string" || !o) return null;
  let u;
  try { u = new URL(o); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;
  return o.replace(/\/$/, "") === u.origin ? u.origin : null;
}

export class AgentGrants {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) { this.v = vault; this.db = vault.db; }

  /** The login a grant may name, checked: it must exist, pass its MAC and be a login. */
  login(name) {
    const r = this.v.row(String(name ?? ""));
    if (!r) throw new Error(`no item named ${name}`);
    if (r.kind !== "login") throw new Error(`${name} is a ${r.kind}; an agent is lent only logins`);
    return r;
  }

  /** Check a grant's input before anything is written. Errors name the login and the origin, never a field. */
  check({ agent, item, origin }) {
    if (!AGENT.test(String(agent ?? ""))) throw new Error(`"${String(agent ?? "").slice(0, 64)}" is not an agent name`);
    const r = this.login(item);
    const o = exactOrigin(origin);
    if (!o) throw new Error("origin must be exactly a scheme, host and port, such as https://app.northwind.test");
    const allowed = hostsOf(r);
    if (!allowed.includes(o)) throw new Error(`${item} is not for ${o}; it is for ${allowed.length ? allowed.join(", ") : "no site yet (give it hosts)"}`);
    return { r, o };
  }

  /** Whether a row is in force now: active, not revoked, not expired. */
  live(g, t = this.v.clock()) { return g.status === "active" && !g.revoked && (g.expires == null || Number(g.expires) > t); }

  /** What a listing shows for a row's status. */
  statusOf(g, t = this.v.clock()) {
    if (g.revoked || g.status === "revoked") return "revoked";
    if (g.expires != null && Number(g.expires) <= t) return "expired";
    return g.status;
  }

  out(g) {
    return { id: g.id, agent: g.agent, item: g.item, origin: g.origin, expires: g.expires ?? null, status: this.statusOf(g) };
  }

  /** The words a person reads before proving presence. Never a username. */
  summary({ agent, item, origin, expires }, parseExpiry) {
    if (typeof agent !== "string" || typeof item !== "string" || typeof origin !== "string") return "";
    let until = "";
    try { until = ` until ${day(parseExpiry(expires))}`; } catch {}
    const r = this.v.row(String(item ?? ""));
    const move = r && r.vault === "personal" ? "; this moves it out of your password-protected vault" : "";
    return `Let ${String(agent).slice(0, 32)} sign in to ${String(origin).slice(0, 200)} as ${String(item).slice(0, 128)}${until}${move}`;
  }

  /**
   * Grant, or ask for one. A person's grant is active at once; Claude's (mcp) waits as pending.
   * @param {{ agent: string, item: string, origin: string, expires: number }} g @param {string} caller @param {boolean} pending
   */
  async grant({ agent, item, origin, expires }, caller, pending) {
    await this.v.key();
    const { r, o } = this.check({ agent, item, origin });
    const t = this.v.clock();
    if (expires <= t) throw new Error("that expiry is in the past");
    const old = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE item=? AND agent=? AND origin=?").get(r.name, agent, o));
    const good = old && this.v.rowOk("vault_agent_grants", old);
    // Claude asking again for what is already in force changes nothing.
    if (pending && good && this.live(old, t)) return { grant: this.out(old) };
    const status = pending ? "pending" : "active";
    // The agent's computer is filled while nobody is here, so a lent login lives in the agent vault.
    if (!pending && r.vault === "personal") await this.v.reseal(r, "agents");
    const id = old ? old.id : newId();
    this.db.prepare("INSERT OR REPLACE INTO vault_agent_grants (id, item, agent, origin, expires, status, by, at, revoked) VALUES (?,?,?,?,?,?,?,?,NULL)")
      .run(id, r.name, agent, o, expires, status, String(caller), t);
    this.v.sign("vault_agent_grants", id);
    const g = this.db.prepare("SELECT * FROM vault_agent_grants WHERE id=?").get(id);
    this.v.audit(pending ? "agent-grant-requested" : "agent-grant", r.name, caller, true, `agent:${agent}`, { origin: o });
    this.v.emit(pending ? "grant.requested" : "vault.agent-granted", { agent, item: r.name, origin: o });
    return { grant: this.out(g) };
  }

  /** Pending agent grants, for vault.pending. */
  pending() {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE status='pending' AND revoked IS NULL ORDER BY at").all())
      .filter(g => this.v.rowOk("vault_agent_grants", g)).map(g => ({ ...this.out(g), by: g.by, at: g.at }));
  }

  /** Approve a pending agent grant (vault.approve with an ag_ id). Null when there is none. */
  async approve(id, caller) {
    await this.v.key();
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE id=? AND status='pending' AND revoked IS NULL").get(id));
    if (!g || !this.v.rowOk("vault_agent_grants", g)) return null;
    if (g.expires != null && Number(g.expires) <= this.v.clock()) throw new Error(`agent grant ${id} expired before it was approved; ask again`);
    // The login may have changed since: its hosts must still include the origin.
    const { r } = this.check({ agent: g.agent, item: g.item, origin: g.origin });
    if (r.vault === "personal") await this.v.reseal(r, "agents");
    this.db.prepare("UPDATE vault_agent_grants SET status='active', by=?, at=? WHERE id=?").run(String(caller), this.v.clock(), id);
    this.v.sign("vault_agent_grants", id);
    this.v.audit("agent-grant", g.item, caller, true, `approved agent:${g.agent}`, { origin: g.origin });
    this.v.emit("vault.agent-granted", { agent: g.agent, item: g.item, origin: g.origin });
    return { approved: this.out({ ...g, status: "active" }) };
  }

  /** Take one grant away. Always allowed, for any row, even one that fails its check. */
  revoke({ id }, caller) {
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE id=?").get(String(id ?? "")));
    if (!g) throw new Error(`no agent grant ${id}`);
    if (g.revoked) return { revoked: false, grant: this.out(g) };
    const good = this.v.rowOk("vault_agent_grants", g);
    const t = this.v.clock();
    this.db.prepare("UPDATE vault_agent_grants SET status='revoked', revoked=? WHERE id=?").run(t, g.id);
    if (good) this.v.sign("vault_agent_grants", g.id);
    this.v.audit("agent-revoke", g.item, caller, true, `agent:${g.agent}`, { origin: g.origin });
    this.v.emit("vault.agent-revoked", { agent: g.agent, item: g.item, origin: g.origin });
    return { revoked: true, grant: this.out({ ...g, status: "revoked", revoked: t }) };
  }

  /** Every grant naming an item goes when the item goes. */
  revokeItem(item, caller) {
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT id FROM vault_agent_grants WHERE item=? AND revoked IS NULL").all(item));
    for (const g of rows) this.revoke({ id: g.id }, caller);
    return rows.length;
  }

  /** Grants, newest first, with the last use and a use count. Names only. */
  async list({ agent, item } = {}) {
    try { await this.v.key(); } catch { /* a locked passphrase vault lists without checks */ }
    const where = [], args = [];
    if (agent) { where.push("agent=?"); args.push(String(agent)); }
    if (item) { where.push("item=?"); args.push(String(item)); }
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT * FROM vault_agent_grants${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY at DESC`).all(...args))
      .filter(g => this.v.rowOk("vault_agent_grants", g));
    const use = this.db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM vault_audit WHERE action='agent-fill' AND ok=1 AND name=? AND who=? AND origin=?");
    return {
      grants: rows.map(g => {
        const u = /** @type {any} */ (use.get(g.item, `agent:${g.agent}`, g.origin));
        return { ...this.out(g), by: g.by ?? null, at: g.at, lastUsed: u.last ?? null, uses: Number(u.n) };
      }),
    };
  }

  /** The grant in force for (agent, item, origin), or null: active, unexpired and MAC-valid. */
  async grantFor(agent, item, origin) {
    await this.v.key();
    const o = exactOrigin(origin);
    if (!o) return null;
    const g = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_agent_grants WHERE item=? AND agent=? AND origin=?").get(String(item), String(agent), o));
    if (!g || !this.v.rowOk("vault_agent_grants", g) || !this.live(g)) return null;
    const r = this.v.row(g.item);
    if (!r || r.kind !== "login" || !hostsOf(r).includes(o)) return null;
    return this.out(g);
  }

  /**
   * Write one use to the audit trail. `who` is "agent:<name>", "device:<id>:<name>",
   * "module:<m>" or a person's surface; `why` is a short reason on a refusal, never a value.
   * @param {{ action: string, item: string|null, who: string, ok?: boolean, origin?: string|null, surface?: string|null, why?: string|null }} u
   */
  recordUse({ action, item, who, ok = true, origin = null, surface = null, why = null }) {
    if (!USE_ACTIONS.includes(action)) throw new Error(`${action} is not a use`);
    if (surface != null && !SURFACES.includes(surface)) throw new Error(`surface must be one of ${SURFACES.join(", ")}`);
    this.v.audit(action, item, who, ok, why, { origin: origin ? exactOrigin(origin) ?? null : null, surface });
  }

  /**
   * The log of every use, newest first, from the audit rows. Rows from before origin and surface
   * had columns carry them in `why`; those are read back where the shape is known.
   * @param {{ item?: string, agent?: string, since?: number|string, limit?: number }} q
   */
  uses({ item, agent, since, limit = 100 } = {}) {
    const where = [`action IN (${USE_ACTIONS.map(() => "?").join(",")})`], args = [...USE_ACTIONS];
    if (item) { where.push("name=?"); args.push(String(item)); }
    if (agent && !AGENT.test(String(agent))) throw new Error(`"${String(agent).slice(0, 64)}" is not an agent name`);
    if (agent) { where.push("(who=? OR who LIKE ?)"); args.push(`agent:${agent}`, `% agent:${agent}`); }
    if (since !== undefined && since !== null && since !== "") {
      const t = typeof since === "number" ? since : /^\d+$/.test(String(since)) ? Number(since) : Date.parse(String(since));
      if (Number.isNaN(t)) throw new Error(`since "${since}" is not a date`);
      where.push("at>=?"); args.push(t);
    }
    const n = Math.max(1, Math.min(1000, Number(limit) || 100));
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT * FROM vault_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, n));
    return {
      uses: rows.map(r => {
        const w = older(r);
        const o = r.origin ?? w.origin, s = r.surface ?? w.surface;
        return { at: r.at, action: r.action, item: r.name ?? null, who: r.who, ...(o ? { origin: o } : {}), ...(s ? { surface: s } : {}), ok: Boolean(r.ok) };
      }),
    };
  }
}

/** Origin and surface from an audit row's `why`, for the shapes older code writes. */
function older(r) {
  const why = typeof r.why === "string" ? r.why : "";
  const out = { origin: null, surface: null };
  if (r.action === "fill" && r.ok) out.origin = exactOrigin(why);
  if (r.action === "relay" && r.ok) out.origin = exactOrigin(why.split(" ")[0]);
  const on = / on ([a-z]+)\b/.exec(why);
  if (on && SURFACES.includes(on[1])) out.surface = on[1];
  return out;
}
