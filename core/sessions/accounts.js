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
import { addressRefused, metadataName } from "./endpoint.js";

// kind: what the credential is. "api-key" and "setup-token" name a vault item; "login" names none:
// the provider's own sign-in (codex login, grok login) wrote its token into this account's own
// HOME, which only this account's uid can read. uid: the account's own user on a box (UID_MIN to
// UID_MAX, the box image's range); a Mac has one user, so there it only numbers the account.
export const ACCOUNTS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'api-key', vault_item TEXT,
  scope_projects TEXT NOT NULL, scope_agents TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  uid INTEGER, signed_in_at INTEGER, added INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions_uids_dirty (uid INTEGER PRIMARY KEY);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_accounts_uid ON sessions_accounts(uid);`;

/** An account a non-person caller started: unusable (pending) until a person finishes the step on their own device (the person's own confirm on their surface, after a login's sign-in has finished or for a key's account). */
export const ACCOUNTS_PENDING_MIGRATION = `ALTER TABLE sessions_accounts ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`;

/** Whether the provider keeps and may train on this account's sessions (1: privacy mode on, it does not; 0: off). Only Grok has such a setting, held by xAI for the account; this is Vyre's record of the person's choice. */
export const ACCOUNTS_PRIVACY_MIGRATION = `ALTER TABLE sessions_accounts ADD COLUMN privacy INTEGER NOT NULL DEFAULT 1`;

/** An API-key account's own endpoint and default model (the setup screen's OpenAI-compatible and Anthropic-compatible keys). Both are plain text, never a secret. */
export const ACCOUNTS_ENDPOINT_MIGRATION = `ALTER TABLE sessions_accounts ADD COLUMN base_url TEXT;
ALTER TABLE sessions_accounts ADD COLUMN model TEXT`;

/**
 * An endpoint a key may be sent to: https, or plain http to this machine only; no login in the address, no query or fragment, nothing that names the cloud's
 * metadata service. Returns the address without a trailing slash, or throws bad_input saying why.
 * @param {any} u @returns {string}
 */
export function endpointOk(u) {
  const text = String(u || "").trim();
  let x;
  try { x = new URL(text); } catch { throw bad("that is not a web address"); }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname);
  if (!(x.protocol === "https:" || (x.protocol === "http:" && loop))) throw bad("the address must be https (plain http only to this machine)");
  if (x.username || x.password) throw bad("the address must not carry a login");
  if (x.search || x.hash) throw bad("the address must not have a query or a fragment");
  if (addressRefused(x.hostname) || metadataName(x.hostname)) throw bad("that address is not a place a key may be sent");
  if (text.length > 300) throw bad("the address is too long");
  return `${x.protocol}//${x.host}${x.pathname}`.replace(/\/+$/, "");
}

/** The box image's account uids (integrator's Wave A0 image): 2000-2063, gid = uid. */
export const UID_MIN = 2000;
export const UID_MAX = 2063;
export const KINDS = ["api-key", "setup-token", "login"];

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
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ wipe?: (uid: number) => Promise<any> }} [o] wipe: empty a uid's HOME (the spawner's
   *   wipe op). A uid whose account was removed is handed to a new account only after this
   *   succeeds, so nothing of the last account's sign-in is ever there for the next.
   */
  constructor(db, o = {}) { this.db = db; this.wipe = o.wipe || null; /** @type {Promise<any>} */ this.lock = Promise.resolve(); }

  row(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM sessions_accounts WHERE id = ?").get(String(id)));
    return r ? this.fromRow(r) : null;
  }

  fromRow(r) {
    return { id: r.id, provider: r.provider, label: r.label, kind: r.kind || "api-key", vault_item: r.vault_item == null ? null : r.vault_item, uid: r.uid == null ? null : Number(r.uid), signed_in_at: r.signed_in_at == null ? null : Number(r.signed_in_at),
      scope: { projects: JSON.parse(r.scope_projects), agents: JSON.parse(r.scope_agents) },
      is_default: Boolean(r.is_default), pending: Boolean(r.pending), privacy: r.provider === "grok" ? Boolean(r.privacy ?? 1) : null, base_url: r.base_url == null ? null : String(r.base_url), model: r.model == null ? null : String(r.model), needs: (r.kind || "api-key") === "login" && r.signed_in_at == null ? "sign-in" : (r.pending ? "confirm" : null), added: r.added, updated: r.updated };
  }

  /** Every account for a provider (or every account, provider omitted), plus a synthesized
   * "default" one when the provider has none configured yet - today's one-account-per-machine
   * behavior, unchanged until a person adds a real row. */
  list(provider) {
    const rows = provider
      ? /** @type {any[]} */ (this.db.prepare("SELECT * FROM sessions_accounts WHERE provider = ? ORDER BY added").all(String(provider))).map(r => this.fromRow(r))
      : /** @type {any[]} */ (this.db.prepare("SELECT * FROM sessions_accounts ORDER BY provider, added").all()).map(r => this.fromRow(r));
    if (provider === "claude" && !rows.some(r => r.provider === "claude")) {
      rows.push({ id: "default", provider: "claude", label: "Default", kind: "login", vault_item: null, uid: null,
        scope: { projects: "*", agents: "*" }, is_default: true, added: 0, updated: 0, synthetic: true });
    }
    return rows;
  }

  /**
   * The lowest uid in the box's account range no account holds. One removed earlier is reused only
   * after its HOME was emptied (a wipe that fails, say because a session of it still runs, leaves
   * it out for now); a fresh one never held anything.
   */
  async allocate() {
    const used = new Set(/** @type {any[]} */ (this.db.prepare("SELECT uid FROM sessions_accounts WHERE uid IS NOT NULL").all()).map(r => Number(r.uid)));
    const dirty = new Set(/** @type {any[]} */ (this.db.prepare("SELECT uid FROM sessions_uids_dirty").all()).map(r => Number(r.uid)));
    for (let u = UID_MIN; u <= UID_MAX; u++) if (!used.has(u) && !dirty.has(u)) return u;
    for (const u of [...dirty].sort((a, b) => a - b)) {
      if (used.has(u) || !this.wipe) continue;
      try { await this.wipe(u); } catch { continue; }
      this.db.prepare("DELETE FROM sessions_uids_dirty WHERE uid = ?").run(u);
      return u;
    }
    throw Object.assign(new Error(`this server has ${UID_MAX - UID_MIN + 1} accounts, the most it holds; remove one first`), { code: "too_many" });
  }

  /**
   * Add an account: a label, its kind, and (for an api-key or setup-token) the vault item that
   * already holds its credential (vault's to fill; this never sees or stores a credential value).
   * A "login" account has no vault item: the provider's own sign-in fills its HOME. Person-only
   * for now (adding a real account is provisioning access, weighted like vault.grant), even though
   * picking WHICH already-added account a project uses is not (see resolve/bind).
   * @param {{ provider: string, label: string, kind?: string, vault_item?: string, scope?: any, is_default?: boolean }} i
   */
  add(i) {
    // Allocate and insert run one at a time: two adds landing together must never take one uid
    // (two accounts on one uid can read each other's sign-in). The unique index is the backstop.
    const run = this.lock.then(() => this.addNow(i));
    this.lock = run.catch(() => {});
    return run;
  }

  /** @param {any} i */
  async addNow(i) {
    const provider = String(i.provider || "");
    if (!PROVIDER.test(provider)) throw bad("provider must be a lowercase name like claude, codex or grok");
    const label = String(i.label || "").trim();
    if (!label) throw bad("label is required");
    const kind = String(i.kind || (i.vault_item ? "api-key" : "login"));
    if (!KINDS.includes(kind)) throw bad(`kind is one of ${KINDS.join(", ")}`);
    const vaultItem = i.vault_item == null ? null : String(i.vault_item);
    if (kind === "login" ? vaultItem !== null : !vaultItem || !VAULT_ITEM.test(vaultItem)) throw bad(kind === "login" ? "a login account holds no vault item" : "vault_item must name an existing vault item");
    const scope = normalizeScope(i.scope);
    const id = crypto.randomBytes(6).toString("hex");
    const uid = await this.allocate();
    const now = Date.now();
    if (i.is_default) this.db.prepare("UPDATE sessions_accounts SET is_default = 0 WHERE provider = ?").run(provider);
    this.db.prepare(`INSERT INTO sessions_accounts (id, provider, label, kind, vault_item, scope_projects, scope_agents, is_default, uid, added, updated, pending, base_url, model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, provider, label, kind, vaultItem, JSON.stringify(scope.projects), JSON.stringify(scope.agents), i.is_default ? 1 : 0, uid, now, now, i.pending ? 1 : 0,
      i.base_url == null ? null : endpointOk(i.base_url), i.model == null || i.model === "" ? null : String(i.model).slice(0, 100));
    return this.row(id);
  }

  /** The person's privacy choice for an account on a provider that has one. @param {string} id @param {boolean} on */
  setPrivacy(id, on) {
    const r = this.row(id);
    if (!r || r.synthetic) throw Object.assign(new Error(`no account ${id}`), { code: "not_found" });
    if (r.provider !== "grok") throw Object.assign(new Error(`${r.provider} has no privacy setting`), { code: "bad_input" });
    this.db.prepare("UPDATE sessions_accounts SET privacy = ?, updated = ? WHERE id = ?").run(on ? 1 : 0, Date.now(), String(id));
    return this.row(id);
  }

  /** A login account finished its provider's own sign-in. @param {string} id */
  markSignedIn(id) { this.db.prepare("UPDATE sessions_accounts SET signed_in_at = ?, updated = ? WHERE id = ?").run(Date.now(), Date.now(), String(id)); return this.row(id); }

  remove(id) {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error(`no account ${id}`), { code: "not_found" });
    this.db.prepare("DELETE FROM sessions_accounts WHERE id = ?").run(String(id));
    // Its uid, and the HOME with its sign-in, wait for a wipe before another account takes them.
    if (r.uid != null) this.db.prepare("INSERT OR IGNORE INTO sessions_uids_dirty (uid) VALUES (?)").run(r.uid);
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
    this.db.prepare("UPDATE sessions_accounts SET scope_projects = ?, scope_agents = ?, is_default = ?, pending = ?, updated = ? WHERE id = ?")
      .run(JSON.stringify(scope.projects), JSON.stringify(scope.agents), i.is_default ? 1 : (r.is_default ? 1 : 0), i.confirm && !(r.kind === "login" && r.signed_in_at == null) ? 0 : (r.pending ? 1 : 0), now, r.id);
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
    const listed = this.list(provider);
    // An account a non-person started is not usable until the person finishes it on their own device: never chosen, never a fallback.
    const all = listed.filter(a => !a.pending);
    const real = all.filter(a => !a.synthetic);

    if (i.account) {
      const waiting = listed.find(a => a.id === i.account && a.pending);
      if (waiting) throw Object.assign(new Error(`${waiting.label} is waiting for the person to finish setting it up on their own device`), { code: "pending" });
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
