// @ts-check
// Several accounts per provider (ADR 0030, 0.2 charter minimum 5), and which one a session uses.
//
// An account names a vault item (never a credential value): the same shape core/mcp/hub.js's
// server rows already use for a connector's auth (auth.item), so this is not a second scoping
// language. Vault owns the credential itself - its storage, rotation and the sign-in flow that
// fills it. Sessions owns the resolution: which account a project, agent or explicit call uses,
// and the scope check that keeps one account's grant from crossing into a project it was never
// given to (reviewer-2's H1: an explicit account still has to pass this, not skip it).
//
// Claude needs no migration to keep working: with no sessions_accounts row for it at all,
// resolve() and list() both synthesize one "default" account from this machine's existing
// sessions.auth config (core/sessions/config.js), so a box or Mac set up before this shipped is
// unchanged until a person adds a second account.

import crypto from "node:crypto";

export const ACCOUNTS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, vault_item TEXT NOT NULL,
  scope_projects TEXT NOT NULL, scope_agents TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL, updated INTEGER NOT NULL
);`;

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VAULT_ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });

/** { projects: "*"|[ids], agents: "*"|[names] } - the MCP hub's own scope shape (core/mcp/hub.js), reused as is. */
function normalizeScope(s) {
  if (s === undefined || s === null) return { projects: "*", agents: "*" };
  if (typeof s !== "object" || Array.isArray(s)) throw bad('scope is { projects: "*" | [ids], agents: "*" | [names] }');
  const one = (v, what) => {
    if (v === undefined || v === "*") return "*";
    if (!Array.isArray(v) || !v.every(x => typeof x === "string" && x)) throw bad(`scope.${what} must be "*" or a list of strings`);
    return [...new Set(v)];
  };
  return { projects: one(s.projects, "projects"), agents: one(s.agents, "agents") };
}

/** Does this scope cover a project/agent? "*" covers everything; an absent target is covered only by "*". */
function inScope(scope, { project, agent }) {
  const one = (v, target) => v === "*" || (target != null && v.includes(target));
  return one(scope.projects, project) && one(scope.agents, agent);
}

export class Accounts {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) { this.db = db; }

  row(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM sessions_accounts WHERE id = ?").get(String(id)));
    return r ? this.fromRow(r) : null;
  }

  fromRow(r) {
    return { id: r.id, provider: r.provider, label: r.label, vault_item: r.vault_item,
      scope: { projects: JSON.parse(r.scope_projects), agents: JSON.parse(r.scope_agents) },
      is_default: Boolean(r.is_default), added: r.added, updated: r.updated };
  }

  /** Every account for a provider (or every account, provider omitted), plus a synthesized
   * "default" one when the provider has none configured yet - today's one-account-per-machine
   * behavior, unchanged until a person adds a real row. */
  list(provider) {
    const rows = provider
      ? /** @type {any[]} */ (this.db.prepare("SELECT * FROM sessions_accounts WHERE provider = ? ORDER BY added").all(String(provider))).map(r => this.fromRow(r))
      : /** @type {any[]} */ (this.db.prepare("SELECT * FROM sessions_accounts ORDER BY provider, added").all()).map(r => this.fromRow(r));
    if (provider === "claude" && !rows.some(r => r.provider === "claude")) {
      rows.push({ id: "default", provider: "claude", label: "Default", vault_item: null,
        scope: { projects: "*", agents: "*" }, is_default: true, added: 0, updated: 0, synthetic: true });
    }
    return rows;
  }

  /**
   * Add an account: a label and the vault item that already holds its credential (vault's to
   * fill; this never sees or stores a credential value). Person-only for now (adding a real
   * account is provisioning access, weighted like vault.grant), even though picking WHICH
   * already-added account a project uses is not (see resolve/bind) - open question for the
   * charter's "configurable by agents too", flagged in plans/sessions.md 3.6.
   * @param {{ provider: string, label: string, vault_item: string, scope?: any, is_default?: boolean }} i
   */
  add(i) {
    const provider = String(i.provider || "");
    if (!PROVIDER.test(provider)) throw bad("provider must be a lowercase name like claude, codex or grok");
    const label = String(i.label || "").trim();
    if (!label) throw bad("label is required");
    const vaultItem = String(i.vault_item || "");
    if (!VAULT_ITEM.test(vaultItem)) throw bad("vault_item must name an existing vault item");
    const scope = normalizeScope(i.scope);
    const id = crypto.randomBytes(6).toString("hex");
    const now = Date.now();
    if (i.is_default) this.db.prepare("UPDATE sessions_accounts SET is_default = 0 WHERE provider = ?").run(provider);
    this.db.prepare(`INSERT INTO sessions_accounts (id, provider, label, vault_item, scope_projects, scope_agents, is_default, added, updated)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, provider, label, vaultItem, JSON.stringify(scope.projects), JSON.stringify(scope.agents), i.is_default ? 1 : 0, now, now);
    return this.row(id);
  }

  remove(id) {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error(`no account ${id}`), { code: "not_found" });
    this.db.prepare("DELETE FROM sessions_accounts WHERE id = ?").run(String(id));
    return { id: String(id), removed: true };
  }

  /** Add or replace a project/agent's place in an account's scope, or set it as its provider's default. */
  bind(i) {
    const r = this.row(i.id);
    if (!r || r.synthetic) throw Object.assign(new Error(`no account ${i.id}`), { code: "not_found" });
    const add = (list, v) => (list === "*" ? "*" : [...new Set([...list, v])]);
    const scope = { ...r.scope };
    if (i.project) scope.projects = add(scope.projects, String(i.project));
    if (i.agent) scope.agents = add(scope.agents, String(i.agent));
    const now = Date.now();
    if (i.is_default) this.db.prepare("UPDATE sessions_accounts SET is_default = 0 WHERE provider = ?").run(r.provider);
    this.db.prepare("UPDATE sessions_accounts SET scope_projects = ?, scope_agents = ?, is_default = ?, updated = ? WHERE id = ?")
      .run(JSON.stringify(scope.projects), JSON.stringify(scope.agents), i.is_default ? 1 : (r.is_default ? 1 : 0), now, r.id);
    return this.row(r.id);
  }

  /**
   * Resolution order (plans/sessions.md 3.2, H1's fix applied): whichever way an account is
   * chosen, its scope is checked against the target project/agent before it is used. An explicit
   * account out of scope is a refusal, never a fallback to a different one (reviewer-2's finding:
   * the assistant, or anything a prompt injection shapes, must not be able to reach another
   * project's account just by naming it).
   * @param {{ provider: string, account?: string|null, project?: string|null, agent?: string|null }} i
   * @returns {any} the resolved account (never synthetic-only unless nothing else exists), or null
   *   when the provider has no accounts configured at all (today's single-credential behavior).
   */
  resolve(i) {
    const provider = String(i.provider || "");
    const target = { project: i.project || null, agent: i.agent || null };
    const all = this.list(provider);
    const real = all.filter(a => !a.synthetic);

    if (i.account) {
      const chosen = all.find(a => a.id === i.account);
      if (!chosen) throw Object.assign(new Error(`no account ${i.account} on ${provider}`), { code: "not_found" });
      if (!inScope(chosen.scope, target)) throw Object.assign(new Error(`${chosen.label} is not granted to ${target.project ? "project " + target.project : target.agent ? "agent " + target.agent : "this call"}`), { code: "denied" });
      return chosen;
    }
    if (target.agent) { const a = real.find(a => a.provider === provider && inScope(a.scope, target) && a.scope.agents !== "*" && a.scope.agents.includes(target.agent)); if (a) return a; }
    if (target.project) { const a = real.find(a => a.provider === provider && inScope(a.scope, target) && a.scope.projects !== "*" && a.scope.projects.includes(target.project)); if (a) return a; }
    const def = all.find(a => a.provider === provider && a.is_default && inScope(a.scope, target));
    if (def) return def;
    if (!real.length) return all[0] || null; // only the synthetic default exists: today's behavior
    if (real.length === 1 && inScope(real[0].scope, target)) return real[0];
    throw Object.assign(new Error(`${provider} has ${real.length} accounts and none resolved for this call; name one explicitly`), { code: "ambiguous", accounts: real.map(a => ({ id: a.id, label: a.label })) });
  }
}
