// @ts-check
// Routing and fallback order (plans/sessions.md 9.4): an ordered list of (provider, account)
// pairs per agent, per project or as the machine default, e.g. Claude (work), then Codex, then
// Grok. When a thread's turn hits its limit it moves to the next entry, through the same handoff
// as a person's mid-session switch (Switchboard.switchProvider), and says so in the transcript.
//
// Two entries on the SAME provider in one list are the textbook way to combine two accounts'
// quota, which most providers' terms treat as rate-limit evasion. That is the person's call, so
// it is not blocked: the list is saved only with `acknowledge: true`, after this warning is shown.

export const ROUTES_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_routes (
  scope TEXT PRIMARY KEY, entries TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, by TEXT, at INTEGER NOT NULL
);`;

const SCOPE = /^(default|project:[a-z0-9][a-z0-9-]{0,62}|agent:[a-z0-9][a-z0-9-]{0,39})$/;
const bad = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

export const sameProviderWarning = provider =>
  `Using two ${provider} accounts to route around its own limit may break its terms. Save the list anyway only if that is what you mean.`;

export class Routes {
  /** @param {import("node:sqlite").DatabaseSync} db @param {(name: string) => boolean} known is this provider one this machine has? */
  constructor(db, known) { this.db = db; this.known = known; }

  /** @param {string} scope */
  get(scope) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM sessions_routes WHERE scope = ?").get(scope));
    return r ? { scope: r.scope, entries: JSON.parse(String(r.entries)), acknowledged: Boolean(r.acknowledged), by: r.by, at: r.at } : null;
  }

  all() { return /** @type {any[]} */ (this.db.prepare("SELECT scope FROM sessions_routes ORDER BY scope").all()).map(r => this.get(String(r.scope))); }

  /**
   * @param {{ scope: string, entries: { provider: string, account?: string }[], acknowledge?: boolean }} i @param {string|null} by
   */
  set(i, by = null) {
    const scope = String(i.scope || "");
    if (!SCOPE.test(scope)) throw bad("scope is default, project:<slug> or agent:<name>");
    if (!Array.isArray(i.entries) || i.entries.length > 8) throw bad("entries is a list of at most 8 { provider, account? }");
    const entries = i.entries.map(e => {
      const provider = String(e && e.provider || "");
      if (!this.known(provider)) throw bad(`no session provider ${provider}`);
      const model = e && e.model ? String(e.model) : "";
      if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,120}$/.test(model)) throw bad("a model is an id like anthropic/claude-haiku-4.5");
      return { provider, ...(e.account ? { account: String(e.account) } : {}), ...(model ? { model } : {}) };
    });
    const seen = new Set();
    for (const e of entries) {
      const key = `${e.provider}:${e.account || ""}`;
      if (seen.has(key)) throw bad(`${e.provider}${e.account ? ` (${e.account})` : ""} is in the list twice`);
      seen.add(key);
    }
    const dup = entries.find((e, n) => entries.findIndex(x => x.provider === e.provider) !== n);
    if (dup && i.acknowledge !== true) throw Object.assign(new Error(sameProviderWarning(dup.provider)), { code: "needs_acknowledgement", provider: dup.provider });
    if (!entries.length) { this.db.prepare("DELETE FROM sessions_routes WHERE scope = ?").run(scope); return { scope, entries: [], acknowledged: false }; }
    this.db.prepare("INSERT INTO sessions_routes (scope, entries, acknowledged, by, at) VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET entries = excluded.entries, acknowledged = excluded.acknowledged, by = excluded.by, at = excluded.at")
      .run(scope, JSON.stringify(entries), dup ? 1 : 0, by, Date.now());
    return this.get(scope);
  }

  /** The list that applies: the agent's own, else the project's, else the machine's. */
  listFor({ agent = null, project = null } = {}) {
    for (const s of [agent && `agent:${agent}`, project && `project:${project}`, "default"]) { const r = s && this.get(s); if (r && r.entries.length) return r; }
    return null;
  }

  /**
   * The entry after the one a thread runs on, skipping those already tried in this run of
   * fallbacks (so two limited providers never bounce a thread between them) and those `usable`
   * refuses (an account out of scope, signed out).
   * @param {{ provider: string, account?: string|null, agent?: string|null, project?: string|null, tried?: string[] }} q
   * @param {(e: { provider: string, account?: string }) => boolean} [usable]
   */
  next(q, usable = () => true) {
    const list = this.listFor(q);
    if (!list) return null;
    const tried = new Set(q.tried || []);
    const key = e => `${e.provider}:${e.account || ""}`;
    tried.add(`${q.provider}:${q.account || ""}`);
    const at = list.entries.findIndex(e => e.provider === q.provider && (!e.account || e.account === q.account));
    for (const e of list.entries.slice(at + 1)) if (!tried.has(key(e)) && usable(e)) return { entry: e, scope: list.scope };
    return null;
  }
}
