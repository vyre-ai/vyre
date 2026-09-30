// @ts-check
// sessions: how the sessions Vyre starts run (ADR 0030).
//
// The Switchboard (module "threads") runs every session Vyre starts; this module holds what a
// person sets about them. Two things:
//   - the driver: whether the Claude Agent SDK is installed and in use on this machine
//     (sessions.status, sessions.setup);
//   - the system prompt, editable at three levels (the assistant, each agent, each project),
//     appended to Claude Code's own by default, replaceable as an advanced option, and versioned
//     so a bad edit is undone (sessions.prompt.*). The Switchboard asks sessions.prompt.compose
//     at every start, so an edit applies to the next session, never to one mid-conversation.
//
// Editing a prompt is the person's own act: no model, agent or MCP caller may change what an
// agent is told, its own prompt least of all (core/presence PERSON_ONLY).

import { Prompts, PROMPTS_MIGRATION, REPLACE_WARNING, MAX_CHARS, scopeOf } from "./prompts.js";
import { composeIq, factsFrom } from "./iq-prompt.js";
import { sessionsConfig, sdkDir, claudeBin, configModel, PURPOSES } from "./config.js";
import { Accounts, ACCOUNTS_MIGRATION, KINDS as ACCOUNT_KINDS } from "./accounts.js";
import { Signins, LOGINS } from "./signin.js";
import { spawnSession } from "./spawn.js";
import fs from "node:fs";
import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { Routes, ROUTES_MIGRATION } from "./routes.js";
import { usesSpawner } from "./spawn.js";
import { grokProvider } from "./drivers/grok.js";
import { codexProvider } from "./drivers/codex.js";
import { openrouterProvider } from "./drivers/openrouter.js";
import { wipeAccount } from "../spawner/client.js";

/** Per-purpose and per-project model overrides a person set from a surface. */
const MODELS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_models (scope TEXT PRIMARY KEY, model TEXT NOT NULL, by TEXT, at INTEGER NOT NULL)`;
const MODEL = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
/** A project's default permission mode for new sessions (sessions.mode.set): "Doesn't ask" included. */
const MODES_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_modes (project TEXT PRIMARY KEY, mode TEXT NOT NULL, by TEXT, at INTEGER NOT NULL)`;
const SESSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
/** The model aliases Claude Code takes, the box's one list (surfaces read it from sessions.models.get). */
export const MODEL_ALIASES = Object.freeze([
  { id: "opus", label: "Opus", description: "The most capable" },
  { id: "sonnet", label: "Sonnet", description: "Fast and capable" },
  { id: "haiku", label: "Haiku", description: "The fastest" },
]);
import { installed, install, VERSION, DOWNLOAD_MB } from "./sdk.js";
import { Slots, KINDS, BOX_DEFAULTS } from "./slots.js";

/** Per-project concurrency limits a person set (sessions.limits.set). */
const LIMITS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_limits (project TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (project, kind))`;

/** The agent's own session id for a thread on an ACP provider, so a resume after a vyred restart loads it instead of starting fresh. */
const ACP_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_acp (thread TEXT PRIMARY KEY, provider TEXT NOT NULL, agent_session TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions_openrouter (thread TEXT PRIMARY KEY, messages TEXT NOT NULL)`;

/**
 * "asked" reach, enforced here until the kernel's own check (P17) lands: the tool runs for the
 * person, for a first-party module and for the assistant; any other agent only when meta.asked says
 * the person's own words in their own turn asked for exactly this. Otherwise refused, no prompt.
 * @param {any} meta @param {string} what
 */
export function askedOnly(meta, what) {
  const m = meta || {};
  if (isPerson(m)) return;
  if (m.firstParty && String(m.caller || "").startsWith("module:")) return;
  if (m.agentKind === "assistant") return;
  if (m.asked) return;
  throw Object.assign(new Error(`${what} runs only when the person asked for it; nothing in their own words asked for this`), { code: "not_asked" });
}

/**
 * Where the OpenRouter key may be sent besides openrouter.ai: this machine only, a test double. A
 * VYRE_OPENROUTER_URL in the environment that names any other host is ignored, so a poisoned
 * environment cannot point the key elsewhere.
 * @param {string|undefined} u
 */
export const testBase = u => { try { const x = new URL(String(u)); return x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname); } catch { return false; } };
const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const scope = { type: "string", description: "assistant, agent:<name>, project:<slug> or capsule (the Capsule's quick answer, Vyre IQ)" };

export default {
  async start(ctx) {
    ctx.store.migrate([PROMPTS_MIGRATION, MODELS_MIGRATION, LIMITS_MIGRATION, MODES_MIGRATION, ACCOUNTS_MIGRATION, ACP_MIGRATION, ROUTES_MIGRATION]);
    const db = ctx.store.db;
    // A uid handed to a new account first has its HOME emptied: by the spawner on a box, by
    // removing the account's folder on a machine without one (there the uid only numbers it).
    /** Does the vault hold an item by this name? null when the vault cannot say (not running, locked). Never its value. */
    const vaultHas = async name => { try { const r = await ctx.call("vault.list", {}); const items = r && r.data && (Array.isArray(r.data) ? r.data : r.data.items); return Array.isArray(items) ? items.some(x => x && x.name === name) : null; } catch { return null; } };
    const accounts = new Accounts(db, { wipe: async uid => { if (usesSpawner()) await wipeAccount(uid); } });
    const override = scope => { const r = /** @type {any} */ (db.prepare("SELECT model FROM sessions_models WHERE scope = ?").get(scope)); return r ? String(r.model) : null; };
    /**
     * The model a session runs on: an explicit one, else its agent's, else its project's override,
     * else its purpose's (a surface's override, then config, then the default).
     * @param {{ purpose?: string, project?: string|null, model?: string|null }} i
     */
    const modelFor = i => {
      if (i.model) return { model: i.model, from: "explicit" };
      if (i.project) { const m = override(`project:${i.project}`); if (m) return { model: m, from: `project:${i.project}` }; }
      const purpose = PURPOSES.includes(String(i.purpose)) ? String(i.purpose) : "chat";
      const m = override(`purpose:${purpose}`);
      return m ? { model: m, from: `purpose:${purpose}` } : { model: configModel(ctx.config, purpose), from: `config:${purpose}` };
    };
    const prompts = new Prompts(ctx.store.db);
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";
    const tool = (name, description, input, run, callers, extra = {}) => ctx.tool(name, { description, input, run, ...(callers ? { callers } : {}), ...extra });

    const status = () => {
      const cfg = sessionsConfig(ctx.config);
      const dir = sdkDir(root, cfg);
      const bundled = cfg.claude === "bundled";
      return { driver: cfg.driver, auth: cfg.auth, claude: cfg.claude, idle_minutes: cfg.idle_minutes, max_live: cfg.max_live,
        sdk: { version: VERSION, installed: installed(dir, { bundled }), dir, download_mb: DOWNLOAD_MB.sdk + (bundled ? DOWNLOAD_MB.bundled : 0) },
        binary: cfg.driver === "sdk" ? claudeBin(dir, cfg) || "bundled" : "claude" };
    };

    tool("sessions.status", "How the sessions Vyre starts run on this machine: the driver (sdk or cli), the Claude credential they use (login, setup-token or api-key), which Claude Code, the idle close and the cap, and whether the Agent SDK is installed.",
      { type: "object", properties: {} }, async () => status());

    tool("sessions.setup", "Install the Claude Agent SDK now (it installs itself on first use otherwise) and wait. Says how much it downloads. Sessions use it from the next one on.",
      { type: "object", properties: {} },
      async () => {
        const cfg = sessionsConfig(ctx.config);
        const r = await install(sdkDir(root, cfg), { bundled: cfg.claude === "bundled" });
        if (r.why) throw new Error(r.why);
        return { ...status(), note: "installed; sessions started from now on use it once vyred restarts" };
      }, PEOPLE);

    tool("sessions.prompt.get", "The system prompt set at one level (assistant, agent:<name> or project:<slug>): its text, mode (append or replace) and version, or null when nothing is set.",
      { type: "object", required: ["scope"], properties: { scope } },
      async i => ({ scope: scopeOf(i.scope), prompt: prompts.current(scopeOf(i.scope)) }));

    tool("sessions.prompt.set", `Set the system prompt at one level. mode "append" (the default) adds it after Claude Code's own; "replace" makes it the whole system prompt: ${REPLACE_WARNING} Every edit is a new version; sessions.prompt.revert undoes one. Applies from the next session. Empty text in append mode clears the level. At most ${MAX_CHARS} characters.`,
      { type: "object", required: ["scope", "text"], properties: { scope, text: str, mode: { type: "string", enum: ["append", "replace"] }, note: str } },
      async (i, { caller }) => {
        const row = prompts.set(scopeOf(i.scope), { text: String(i.text), mode: i.mode || "append", by: String(caller || ""), note: i.note || null });
        if (!row.unchanged) ctx.events.emit("prompt.changed", { scope: row.scope, version: row.version, mode: row.mode, by: row.by });
        return { ...row, ...(row.mode === "replace" ? { warning: REPLACE_WARNING } : {}) };
      }, PEOPLE);

    tool("sessions.prompt.history", "Every version of the system prompt at one level, newest first.",
      { type: "object", required: ["scope"], properties: { scope, limit: { type: "integer" } } },
      async i => ({ scope: scopeOf(i.scope), versions: prompts.history(scopeOf(i.scope), i.limit) }));

    tool("sessions.prompt.revert", "Undo edits: make an older version of a level's system prompt the current one again (as a new version, so the revert can be undone too).",
      { type: "object", required: ["scope", "version"], properties: { scope, version: { type: "integer" } } },
      async (i, { caller }) => {
        const row = prompts.revert(scopeOf(i.scope), Number(i.version), String(caller || ""));
        ctx.events.emit("prompt.changed", { scope: row.scope, version: row.version, mode: row.mode, by: row.by });
        return row;
      }, PEOPLE);

    tool("sessions.prompt.preview", "The system prompt a session would start with, for an agent and a project: the levels used and how they combine. Without Vyre's own launch text, which the Switchboard adds. purpose \"capsule\": the Capsule's quick answer (Vyre IQ) with no facts.",
      { type: "object", properties: { agent: str, agent_kind: str, project: str, purpose: { type: "string", enum: ["capsule"] } } },
      async i => i.purpose === "capsule" ? composeIq({ own: prompts.current("capsule") })
        : prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null }));

    // The models a person can pick for a thread (chat's model picker): the aliases Claude Code
    // takes, and any others listed in config (sessions.models_offered: [{id, label}]).
    tool("sessions.models", "The models a thread can switch to (threads.model): id and label, the aliases Claude Code takes first.",
      { type: "object", properties: {} },
      async () => {
        const extra = ctx.config && ctx.config.sessions && Array.isArray(ctx.config.sessions.models_offered) ? ctx.config.sessions.models_offered : [];
        const base = MODEL_ALIASES.map(({ id, label }) => ({ id, label }));
        const seen = new Set(base.map(m => m.id));
        return [...base, ...extra.filter(m => m && typeof m.id === "string" && !seen.has(m.id)).map(m => ({ id: String(m.id), label: String(m.label || m.id) }))];
      });

    tool("sessions.models.get", "What each kind of session runs on: the model per purpose (chat, agent, project, teammate, capsule, job, memory, planner, learn, helper) and per project, and where each comes from. An agent's own model (agents.update) wins over these. aliases is the list of model aliases to offer, with a label and a line each.",
      { type: "object", properties: {} },
      async () => ({ aliases: MODEL_ALIASES, purposes: Object.fromEntries(PURPOSES.map(p => [p, modelFor({ purpose: p })])),
        projects: Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT scope, model FROM sessions_models WHERE scope LIKE 'project:%'").all()).map(r => [String(r.scope).slice(8), String(r.model)])) }));

    tool("sessions.models.set", "Set the model for a purpose (purpose:<chat|agent|project|teammate|capsule|job|memory|planner|learn|helper>) or a project (project:<slug>): an alias (opus, sonnet, haiku) or a full model id. model null removes the override. Applies from the next session.",
      { type: "object", required: ["scope"], properties: { scope: str, model: { type: ["string", "null"] } } },
      async (i, { caller }) => {
        const m = /^(purpose|project):([A-Za-z0-9._-]{1,64})$/.exec(String(i.scope || ""));
        if (!m || (m[1] === "purpose" && !PURPOSES.includes(m[2]))) throw Object.assign(new Error(`scope must be purpose:<${PURPOSES.join("|")}> or project:<slug>`), { code: "bad_input" });
        if (i.model == null || i.model === "") { db.prepare("DELETE FROM sessions_models WHERE scope = ?").run(i.scope); }
        else {
          if (!MODEL.test(String(i.model))) throw Object.assign(new Error("a model is an alias like opus or haiku, or a model id"), { code: "bad_input" });
          db.prepare("INSERT INTO sessions_models (scope, model, by, at) VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET model = excluded.model, by = excluded.by, at = excluded.at")
            .run(i.scope, String(i.model), String(caller || ""), Date.now());
        }
        ctx.events.emit("model.changed", { scope: i.scope, model: i.model || null });
        return { scope: i.scope, model: i.model || null };
      }, PEOPLE);

    ctx.tool("sessions.models.resolve", {
      description: "The model a session starting now runs on, and where that comes from.", internal: true,
      input: { type: "object", properties: { purpose: str, project: str, model: str } },
      run: async i => modelFor(i),
    });

    // ------------------------------------------------------------ providers and accounts (0.2)

    // Claude only for now (0.2 charter narrowed to Claude, Codex, Grok); a module adds another
    // provider with ctx.provider (ADR 0030 section 5) and its own entry here belongs to whichever
    // module registers it - this module only ever speaks for "claude", the one built in. The
    // public name is providers.list (agreed with capsule-pro/native-core, CHAT.md), which lives in
    // the tiny core/providers module since a tool name must start with its own module's name
    // (core/modules/index.js's validation) and "providers" is not this module's name; this is the
    // internal snapshot that module calls through ctx.call.
    const PROVIDERS = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "grok", label: "Grok" }, { id: "openrouter", label: "OpenRouter" }];
    // Codex (through codex-acp) and Grok (its own ACP mode) run on the one generic ACP driver, each
    // with strictest-approval flags at every start and its own sign-in in the account's HOME.
    const acpSessions = provider => ({
      get: id => { const r = /** @type {any} */ (db.prepare("SELECT agent_session FROM sessions_acp WHERE thread = ? AND provider = ?").get(String(id), provider)); return r ? String(r.agent_session) : undefined; },
      set: (id, a) => { db.prepare("INSERT INTO sessions_acp (thread, provider, agent_session) VALUES (?,?,?) ON CONFLICT(thread) DO UPDATE SET agent_session = excluded.agent_session").run(String(id), provider, String(a)); },
    });
    const drivers = { codex: codexProvider({ sessions: acpSessions("codex") }), grok: grokProvider({ sessions: acpSessions("grok") }),
      // The last rung: a plain API-key driver, its conversation kept here so a resume carries on.
      openrouter: openrouterProvider({ ...(testBase(process.env.VYRE_OPENROUTER_URL) ? { baseUrl: process.env.VYRE_OPENROUTER_URL } : {}), store: {
        get: id => { const r = /** @type {any} */ (db.prepare("SELECT messages FROM sessions_openrouter WHERE thread = ?").get(String(id))); try { return r ? JSON.parse(String(r.messages)) : undefined; } catch { return undefined; } },
        set: (id, m) => { db.prepare("INSERT INTO sessions_openrouter (thread, messages) VALUES (?,?) ON CONFLICT(thread) DO UPDATE SET messages = excluded.messages").run(String(id), JSON.stringify(m)); } } }) };
    for (const [name, driver] of Object.entries(drivers)) ctx.provider(name, driver);
    ctx.tool("sessions.providers.snapshot", {
      description: "Every session provider this module speaks for (claude, codex, grok), each with its own accounts and the models it offers. For providers.list (core/providers) to assemble; not a public name itself.", internal: true,
      input: { type: "object", properties: {} },
      run: async () => Promise.all(PROVIDERS.map(async p => ({ ...p,
        accounts: await Promise.all(accounts.list(p.id).map(async a => ({ id: a.id, label: a.label, kind: a.kind, signed_in: a.kind === "login" ? (a.synthetic ? true : a.signed_in_at != null) : !a.vault_item ? true : (await vaultHas(a.vault_item)) !== false, default: a.is_default }))),
        models: p.id === "claude" ? MODEL_ALIASES : [],
        capabilities: p.id === "claude" ? { streaming: true, resume: true, interrupt: true, modes: true, questions: true, transcripts: true } : /** @type {any} */ (drivers)[p.id].capabilities }))),
    });

    // ---- routing and fallback order (plans/sessions.md 9.4)
    // A conversation kept for OpenRouter goes with its thread: swept at start, and on thread.deleted.
    const sweep = () => { try { db.exec("DELETE FROM sessions_openrouter WHERE thread NOT IN (SELECT id FROM threads_runs); DELETE FROM sessions_acp WHERE thread NOT IN (SELECT id FROM threads_runs)"); } catch {} };
    sweep();
    // No thread is deleted anywhere in Vyre today (no such event or path exists), so this also runs hourly:
    // whichever path removes a threads_runs row later, its OpenRouter history goes within the hour.
    const sweeper = setInterval(sweep, 3_600_000); sweeper.unref?.();
    try { ctx.events.on("thread.deleted", e => { const t = e && e.payload && e.payload.thread; if (t) { db.prepare("DELETE FROM sessions_openrouter WHERE thread = ?").run(String(t)); db.prepare("DELETE FROM sessions_acp WHERE thread = ?").run(String(t)); } }); } catch {}
    const routes = new Routes(db, name => PROVIDERS.some(p => p.id === name));
    // Every provider but Claude needs a real, in-scope account: a fallback never runs on a login or key that nobody set up.
    const usable = e => { try { const a = accounts.resolve({ provider: e.provider, ...(e.account ? { account: e.account } : {}) }); return e.provider === "claude" || Boolean(a && !a.synthetic); } catch { return false; } };
    tool("sessions.routes.get", "The fallback order for a scope (default, project:<slug> or agent:<name>): the ordered (provider, account) list a thread moves down when its turn hits a limit. Without a scope, every list.",
      { type: "object", properties: { scope: str } },
      async i => (i.scope ? routes.get(String(i.scope)) : routes.all()));
    tool("sessions.routes.set", `Set the fallback order for a scope: entries is an ordered list of { provider, account? }, e.g. Claude, then Codex, then Grok. An empty list clears it. Two entries on one provider (two accounts combining one vendor's quota) may break that vendor's terms: it saves only with acknowledge: true, after the person has seen the warning. An agent sets only its own list or a project it is granted.`,
      { type: "object", required: ["scope", "entries"], properties: { scope: str, acknowledge: { type: "boolean" },
        entries: { type: "array", items: { type: "object", required: ["provider"], properties: { provider: str, account: str, model: { type: "string", description: "The model this entry runs (required for OpenRouter): what the person chose." } } } } } },
      async (i, meta) => {
        const who = meta && meta.agent ? String(meta.agent) : null;
        if (who) {
          // Grants come from vyred's own read of the agent's stored row, never from the input.
          const granted = /** @type {any} */ (meta).granted;
          const m = /^(project|agent):(.+)$/.exec(String(i.scope));
          const ok = m && (m[1] === "agent" ? m[2] === who : granted === "*" || (Array.isArray(granted) && granted.includes(m[2])));
          if (!ok) throw Object.assign(new Error("an agent sets its own fallback order, or a project it is granted"), { code: "denied" });
        }
        return routes.set(i, who ? `agent:${who}` : String(meta && meta.caller || "person"));
      });
    ctx.tool("sessions.routes.next", {
      description: "The next (provider, account) a limited thread moves to, for the Switchboard. Not a public name.", internal: true,
      input: { type: "object", required: ["provider"], properties: { provider: str, account: str, agent: str, project: str, tried: { type: "array", items: str } } },
      run: async i => routes.next(i, usable),
    });

    tool("sessions.accounts.list", "Every account on a provider, or every account on every provider. Each names a vault item (never a value) and its scope: which projects and agents it is granted to.",
      { type: "object", properties: { provider: str } },
      async (i, meta) => {
        const rows = accounts.list(i.provider ? String(i.provider) : undefined);
        // Vault item names go to people, modules and the assistant; another agent sees the accounts without them.
        const seesItems = !meta || !meta.agent || /** @type {any} */ (meta).agentKind === "assistant";
        return seesItems ? rows : rows.map(({ vault_item, ...r }) => r);
      });

    tool("sessions.accounts.add", `Add an account: a label, its kind, and for an api-key or setup-token the vault item that already holds its credential (add it in the Vault first and grant it to threads; this never touches its value). kind login has no vault item: the provider's own sign-in fills that account's private home. scope is { projects: "*"|[slugs], agents: "*"|[names] }, default "*" (every project and agent may use it until it is bound narrower). is_default makes it the provider's pick when nothing else resolves. Each account runs as its own user on a server, so one account's sign-in is unreadable from another's.`,
      { type: "object", required: ["provider", "label"], properties: { provider: str, label: str, kind: { type: "string", enum: ACCOUNT_KINDS }, vault_item: str,
        scope: { type: "object", properties: { projects: {}, agents: {} } }, is_default: { type: "boolean" } } },
      async (i, meta) => { askedOnly(meta, "Adding an account"); if (i.kind !== "login" && i.vault_item && (await vaultHas(String(i.vault_item))) === false) throw Object.assign(new Error(`the vault has no item ${i.vault_item}; add the credential there first`), { code: "bad_input" }); return accounts.add(i); });

    // ---- signing in (each provider's own login, run as the account; Vyre never sees the token)
    const signins = new Signins({ spawn: (bin, args, { account }) => {
      // On a box the spawner puts the account's uid and HOME in place. Elsewhere a provider that
      // keeps its login in HOME gets one private folder per account.
      const home = usesSpawner() ? undefined : path.join(root, "accounts", String(account.id));
      if (home) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const acctHome = usesSpawner() ? path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct", String(account.uid)) : /** @type {string} */ (home);
      return spawnSession(bin, args, { cwd: acctHome, env: { PATH: process.env.PATH, ...(home ? { HOME: home } : {}), TERM: "dumb", NO_COLOR: "1", BROWSER: "none" }, ...(usesSpawner() && account.uid != null ? { account: { uid: account.uid, shared: false } } : {}) });
    } });
    tool("sessions.accounts.signin", `Sign an account in with its provider's own login (Codex --device-auth, Grok Build's device code, Claude's login), no token pasted or copied. Start: { provider, label? } makes a login account (or { account } for one that exists) and answers { flow, step: "code", url, code } to show; the person approves on any browser. Then { flow } says waiting, done or failed; for a login that wants a code back ({ step: "url", paste: true }) send { flow, code }. The token is written by the provider's own command into that account's private home; Vyre never reads it.`,
      { type: "object", properties: { provider: str, label: str, account: str, flow: str, code: str } },
      async (i, meta) => {
        askedOnly(meta, "Signing in an account");
        if (i.flow && i.code) return signins.submit(String(i.flow), String(i.code));
        if (i.flow) return signins.status(String(i.flow));
        const provider = String(i.provider || "");
        if (!LOGINS[provider] || !PROVIDERS.some(p => p.id === provider)) throw Object.assign(new Error(`there is no sign-in for ${provider || "that provider"}`), { code: "bad_input" });
        if (provider === "claude" && !usesSpawner()) throw Object.assign(new Error("on this machine Claude uses the login already on it (run claude and sign in there)"), { code: "bad_input" });
        let row = i.account ? accounts.row(String(i.account)) : null;
        if (i.account && (!row || row.provider !== provider || row.kind !== "login")) throw Object.assign(new Error("that is not a login account on this provider"), { code: "bad_input" });
        const created = !row;
        if (!row) row = await accounts.add({ provider, label: String(i.label || PROVIDERS.find(p => p.id === provider)?.label || provider), kind: "login" });
        const account = row;
        try { return await signins.start({ provider, account, onDone: ok => { if (ok) accounts.markSignedIn(account.id); else if (created && accounts.row(account.id) && !accounts.row(account.id).signed_in_at) accounts.remove(account.id); } }); }
        catch (e) { if (created) accounts.remove(account.id); throw e; }
      });

    tool("sessions.accounts.remove", "Remove an account. Threads already resumed on it keep running; the next resume on that thread asks for another (a removed account is never a silent fallback).",
      { type: "object", required: ["id"], properties: { id: str } },
      async (i, meta) => { askedOnly(meta, "Removing an account"); return accounts.remove(i.id); });

    tool("sessions.accounts.bind", "Grant an account to one more project or agent (added to its scope, others it already has kept), or make it its provider's default.",
      { type: "object", required: ["id"], properties: { id: str, project: str, agent: str, is_default: { type: "boolean" } } },
      async (i, meta) => { askedOnly(meta, "Binding an account"); return accounts.bind(i); });

    ctx.tool("sessions.accounts.resolve", {
      description: "Which account a session on this provider uses, for a project/agent/explicit choice, scope-checked either way.", internal: true,
      input: { type: "object", required: ["provider"], properties: { provider: str, account: str, project: str, agent: str } },
      run: async i => accounts.resolve(i),
    });

    // ------------------------------------------------------------ concurrency slots

    const boxLimits = () => {
      const l = (ctx.config && ctx.config.sessions && ctx.config.sessions.limits) || {};
      const n = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
      return { teammate: n(l.max_active_teammates, BOX_DEFAULTS.teammate), subagent: n(l.max_subagents, BOX_DEFAULTS.subagent) };
    };
    const projectLimits = slug => Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT kind, value FROM sessions_limits WHERE project = ?").all(String(slug))).map(r => [String(r.kind), Number(r.value)]));
    const slots = new Slots({ limits: () => ({ box: boxLimits(), project: projectLimits }), emit: (type, payload) => { try { ctx.events.emit(type, payload); } catch {} } });
    const kind = { type: "string", enum: KINDS };

    // ------------------------------------------------------------ the usage pause (ADR 0031 section 14)
    // What Claude Code last said about each credential's plan (thread.limit, via the Switchboard).
    // Near the limit (a warning, 80 percent used, or refused), new teammates and subagents on that
    // credential wait instead of starting, until the window resets or the person says "Resume
    // anyway". Sessions already running go on. sessions.pause_at_warning false turns it off.
    /** @type {Map<string, { status: string, kind: string|null, utilization: number|null, resets_at: number|null, at: number, resumed_until?: number }>} */
    const usage = new Map();
    const pauseOn = () => !(ctx.config && ctx.config.sessions && ctx.config.sessions.pause_at_warning === false);
    const resetsMs = (/** @type {any} */ u) => (typeof u.resets_at === "number" ? (u.resets_at < 1e12 ? u.resets_at * 1000 : u.resets_at) : null);
    const pausedFor = (/** @type {string} */ auth) => {
      const u = usage.get(String(auth));
      if (!u || !pauseOn()) return null;
      const near = u.status === "rejected" || u.status === "allowed_warning" || (typeof u.utilization === "number" && u.utilization >= 0.8);
      const until = resetsMs(u);
      if (!near || (until != null && Date.now() >= until) || (u.resumed_until && Date.now() < u.resumed_until)) return null;
      return { auth: String(auth), status: u.status, utilization: u.utilization, resets_at: until };
    };
    const usageRow = (/** @type {string} */ auth) => { const u = usage.get(auth); return u ? { auth, ...u, resets_at: resetsMs(u), paused: Boolean(pausedFor(auth)) } : null; };
    ctx.tool("sessions.usage.report", {
      description: "The Switchboard's report of a credential's plan usage (thread.limit).", internal: true,
      input: { type: "object", required: ["auth", "status"], properties: { auth: str, status: str, kind: str, utilization: { type: "number" }, resets_at: { type: "number" } } },
      run: async i => {
        const auth = String(i.auth);
        const was = Boolean(pausedFor(auth));
        const old = usage.get(auth);
        usage.set(auth, { status: String(i.status), kind: i.kind ?? null, utilization: typeof i.utilization === "number" ? i.utilization : null,
          resets_at: typeof i.resets_at === "number" ? i.resets_at : null, at: Date.now(), ...(old && old.resumed_until ? { resumed_until: old.resumed_until } : {}) });
        const now = pausedFor(auth);
        if (now && !was) ctx.events.emit("usage.paused", now);
        if (!now && was) { ctx.events.emit("usage.resumed", { auth, by: "reset" }); for (const k of KINDS) slots.pump(k); }
        return usageRow(auth);
      },
    });
    tool("sessions.usage.get", "Each Claude credential's plan usage as Claude Code last reported it (status, window, utilization, resets_at), and whether new teammates and subagents on it are paused.",
      { type: "object", properties: {} }, async () => ({ pause_at_warning: pauseOn(), auths: [...usage.keys()].map(usageRow) }));
    tool("sessions.usage.resume", "Resume anyway: start teammates and subagents on this credential again although its plan is near the limit, until the window resets.",
      { type: "object", required: ["auth"], properties: { auth: str } },
      async (i, { caller }) => {
        const auth = String(i.auth);
        const u = usage.get(auth);
        if (!u) return { auth, paused: false, note: "nothing is paused on it" };
        u.resumed_until = resetsMs(u) ?? Date.now() + 5 * 3600_000;
        ctx.events.emit("usage.resumed", { auth, by: String(caller || "") });
        for (const k of KINDS) slots.pump(k);
        return usageRow(auth);
      }, PEOPLE);

    ctx.tool("sessions.slots", {
      description: "The concurrency ledger (for the Switchboard and teammates): take a teammate or subagent slot (waiting its turn, or not), release one, release all an owner holds, or read what is held.", internal: true,
      input: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["take", "release", "release-owner", "status"] }, kind, project: str, owner: str, key: str,
        wait: { type: "boolean" }, timeout_ms: { type: "integer" }, id: str, auth: { type: "string", description: "The credential the new session runs on: its plan's usage pause applies." } } },
      run: async i => {
        if (i.action === "status") return slots.status();
        if (i.action === "release") return { released: i.id ? slots.release(String(i.id)) : slots.releaseKey(String(i.owner), String(i.key)) };
        if (i.action === "release-owner") return { released: slots.releaseOwner(String(i.owner), i.kind || null) };
        const want = { kind: /** @type {any} */ (i.kind), project: String(i.project || "_none"), owner: String(i.owner || ""), key: String(i.key || "") };
        const paused = i.auth ? pausedFor(String(i.auth)) : null;
        if (paused) {
          const pct = typeof paused.utilization === "number" ? `${Math.round(paused.utilization * 100)}% used` : paused.status === "rejected" ? "at its limit" : "near its limit";
          const at = paused.resets_at ? `, until it resets at ${new Date(paused.resets_at).toISOString().slice(11, 16)} UTC` : "";
          throw Object.assign(new Error(`paused: the plan is ${pct}${at}; no new ${want.kind} starts on it (Resume anyway: sessions.usage.resume)`), { code: "usage_paused" });
        }
        const r = slots.take(want, { wait: i.wait !== false, timeoutMs: Math.min(Number(i.timeout_ms) || 10 * 60_000, 60 * 60_000) });
        if (!(r instanceof Promise)) return r;
        const s = await r;
        return { id: s.id, kind: s.kind, project: s.project };
      },
    });

    tool("sessions.slots.status", "How many teammates and subagents are running and waiting, box-wide and per project, and the limits in force.",
      { type: "object", properties: {} }, async () => slots.status());

    tool("sessions.limits.get", "The concurrency limits: box-wide (sessions.limits in config: max_active_teammates, max_subagents) and a project's own.",
      { type: "object", properties: { project: str } },
      async i => ({ box: boxLimits(), ...(i.project ? { project: projectLimits(i.project) } : {}) }));

    tool("sessions.limits.set", "Set a project's limits: at most this many active teammates (max_active) and subagents across all its sessions (max_subagents). null removes one. Over a limit, new ones wait their turn.",
      { type: "object", required: ["project"], properties: { project: str, max_active: { type: ["integer", "null"] }, max_subagents: { type: ["integer", "null"] } } },
      async i => {
        for (const [key, k] of [["max_active", "teammate"], ["max_subagents", "subagent"]]) {
          if (!(key in i)) continue;
          if (i[key] == null) db.prepare("DELETE FROM sessions_limits WHERE project = ? AND kind = ?").run(i.project, k);
          else db.prepare("INSERT INTO sessions_limits (project, kind, value) VALUES (?,?,?) ON CONFLICT(project, kind) DO UPDATE SET value = excluded.value").run(i.project, k, Math.max(0, Number(i[key])));
          slots.pump(k);
        }
        return { project: i.project, ...projectLimits(i.project) };
      }, PEOPLE);

    const projectMode = (/** @type {string} */ project) => {
      const r = /** @type {any} */ (db.prepare("SELECT mode, by, at FROM sessions_modes WHERE project = ?").get(String(project)));
      return r ? { mode: String(r.mode), by: r.by == null ? null : String(r.by), at: Number(r.at) } : null;
    };
    tool("sessions.mode.get", "The permission mode new sessions in a project start in (sessions.mode.set), or null for Claude Code's default (ask).",
      { type: "object", required: ["project"], properties: { project: str } },
      async i => ({ project: String(i.project), ...(projectMode(i.project) || { mode: null }) }));
    tool("sessions.mode.set", "The permission mode new sessions in a project start in: default (ask), acceptEdits, plan or bypassPermissions (\"Doesn't ask\": the security floor and the Gate still hold; only sessions with Vyre's plugin take it). The person's own; default (or no mode) clears it. A running session keeps its mode (threads.mode changes that).",
      { type: "object", required: ["project"], properties: { project: str, mode: { type: "string", enum: SESSION_MODES } } },
      async (i, { caller }) => {
        const project = String(i.project);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(project)) throw Object.assign(new Error("project must be a project's slug"), { code: "bad_input" });
        if (i.mode == null || i.mode === "default") db.prepare("DELETE FROM sessions_modes WHERE project = ?").run(project);
        else {
          if (!SESSION_MODES.includes(String(i.mode))) throw Object.assign(new Error(`mode must be one of ${SESSION_MODES.join(", ")}`), { code: "bad_input" });
          db.prepare("INSERT INTO sessions_modes (project, mode, by, at) VALUES (?,?,?,?) ON CONFLICT(project) DO UPDATE SET mode = excluded.mode, by = excluded.by, at = excluded.at")
            .run(project, String(i.mode), String(caller || ""), Date.now());
        }
        const now = projectMode(project);
        ctx.events.emit("mode.defaulted", { project, mode: now ? now.mode : null });
        return { project, mode: now ? now.mode : null };
      }, PEOPLE);

    ctx.tool("sessions.mode.resolve", {
      description: "The mode a new session in a project starts in, for the Switchboard.", internal: true,
      input: { type: "object", properties: { project: str } },
      run: async i => ({ mode: i.project ? (projectMode(i.project) || { mode: null }).mode : null }),
    });

    ctx.tool("sessions.prompt.compose", {
      description: "The system prompt for a session starting now: the levels around Vyre's own launch text. purpose \"capsule\" is the Capsule's quick answer (Vyre IQ): the whole prompt, with append read as its facts.", internal: true,
      input: { type: "object", properties: { agent: str, agent_kind: str, project: str, append: str, purpose: str, facts: { type: "array", items: str } } },
      run: async i => i.purpose === "capsule"
        ? composeIq({ facts: Array.isArray(i.facts) ? i.facts.map(String) : factsFrom(i.append), own: prompts.current("capsule") })
        : prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null, append: i.append || null }),
    });

    return { async stop() { clearInterval(sweeper); signins.stop(); } };
  },
};
