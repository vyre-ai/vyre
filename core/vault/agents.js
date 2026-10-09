// @ts-check
// agent logins: one agent, one login, one origin (ADR 0028, decision 2), and the log of every use.
//
// An agent grant lets an agent sign in to one site as the person, through vyred's own fill of the agent's computer (decision 3, not built here). It never lets the agent read the login. Who
// may do that is a kernel grant (core/vault/access.js, team/0.3.1/DESIGN-one-grant.md), not a table of the vault's own: this file keeps what a grant is checked against (the login and its
// hosts), the words a person reads before proving presence, and the log of every use. Rows, events and audit lines carry names and origins, never a value or a username.

import { hostsOf } from "./native.js";

/** The vault_agent_grants table (vault.js appends it to MIGRATIONS). Since the one grant model it is only read once, to carry its rows over as kernel grants (access.js `carry`), then emptied. */
export const AGENT_GRANTS_MIGRATION = `CREATE TABLE vault_agent_grants (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER,
     status TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, revoked INTEGER, mac TEXT, UNIQUE (item, agent, origin)
   );
   CREATE INDEX vault_agent_grants_agent ON vault_agent_grants (agent, item);`;

/** Where an audit row came from, for vault.uses (nullable; older rows carry it in `why`). */
export const AUDIT_WHERE_MIGRATION = `ALTER TABLE vault_audit ADD COLUMN origin TEXT;
   ALTER TABLE vault_audit ADD COLUMN surface TEXT;`;

/** The MACed columns of a row carried over: what decided who may sign in where, and until when. */
export const AGENT_GRANT_MACED = ["id", "item", "agent", "origin", "expires", "status", "revoked"];

/** Audit actions that are a use of an item: a value went somewhere, or was asked to. */
export const USE_ACTIONS = ["fill", "agent-fill", "fill-native", "release", "relay", "totp", "copy", "reveal", "inject"];

/** The surfaces a use is recorded from (ADR 0028, decision 2). */
export const SURFACES = ["ios", "android", "mac", "chrome", "firefox", "capsule", "computer", "deck", "cli"];

/** Agent names as core/agents makes them. */
const AGENT = /^[a-z][a-z0-9-]{1,30}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const now = () => Date.now();

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
