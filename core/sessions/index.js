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
import { environmentOf } from "./environment.js";
import { timeLine, zoneFrom } from "../../lib/time/index.js";
import { OPEN as AGENT_OPEN } from "../modules/agent-reach.js";
import { sessionsConfig, sdkDir, claudeBin, configModel, PURPOSES } from "./config.js";
import { Accounts, ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACCOUNTS_PRIVACY_MIGRATION, ACCOUNTS_ENDPOINT_MIGRATION, endpointOk, KINDS as ACCOUNT_KINDS } from "./accounts.js";
import { Signins, LOGINS } from "./signin.js";
import { spawnSession } from "./spawn.js";
import { readIdentity } from "./identity.js";
import crypto from "node:crypto";
import { resolveSafe, pinnedFetch, loopbackRefused } from "../../lib/api-endpoint.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPerson } from "../../lib/caller.js";
import { callerKind } from "../modules/index.js";
import { Routes, ROUTES_MIGRATION } from "./routes.js";
import { usesSpawner } from "./spawn.js";
import { grokProvider } from "./drivers/grok.js";
import { codexProvider } from "./drivers/codex.js";
import { openrouterProvider } from "./drivers/openrouter.js";
import { loginDirect } from "../../lib/door-bridge.js";
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
 * "asked" reach, enforced here until the kernel's own check (P17) lands: the tool runs for a person's own
 * surface; anyone else only when meta.asked says the person's own words in their own turn asked for exactly this; and,
 * for the tools that only start something the person must finish (add, signin, bind), the verified assistant (lead's ruling, 1 Oct).
 * @param {any} meta @param {string} what
 */
/** What a provider last said about itself in a session: the models its account can use and the plan it is on (a model picker's list; null until one session has run). */
const META_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_provider_meta (provider TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', models TEXT, plan TEXT, at INTEGER NOT NULL, PRIMARY KEY (provider, account))`;

export function askedOnly(meta, what, { assistant = false } = {}) {
  const m = meta || {};
  if (isPerson(m)) return;
  if (m.asked) return;
  // The box's own setup page (`setup:<id>`, made only by the relay's setup channel, which reaches only the tools a module declares under setupTools): the person is at it, setting up their box.
  // Not a person anywhere else (reviewer-3 LB-2): the label is refused on the socket and every other tool's reach list.
  if (callerKind(m.caller) === "setup" && m.peer) return;
  // The verified assistant (vyred's meta.agent, never the label) may start an account for the person; the account stays pending until the
  // person finishes it on their own device (accounts.js pending), so this lets it start, never finish.
  if (assistant && m.agent && m.agentKind === "assistant") return;
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
/** The three account tools the verified assistant may START for the person (askedOnly, the lead's 1 Oct ruling): a pending account scoped to the asking session's project, which the person finishes on their own device. */
const ASSISTANT = [...PEOPLE, "module", "mcp"];
const str = { type: "string" };
const scope = { type: "string", description: "assistant, agent:<name>, project:<slug> or capsule (the Capsule's quick answer, Vyre IQ)" };

export default {
  async start(ctx) {
    ctx.store.migrate([PROMPTS_MIGRATION, MODELS_MIGRATION, LIMITS_MIGRATION, MODES_MIGRATION, ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACP_MIGRATION, ROUTES_MIGRATION, META_MIGRATION]);
    const db = ctx.store.db;
    // The privacy column is added by checking for it, not by a numbered migration, so a store that ran an earlier order of migrations still gets it.
    try { db.prepare("SELECT privacy FROM sessions_accounts LIMIT 0").get(); } catch { db.exec(ACCOUNTS_PRIVACY_MIGRATION); }
    try { db.prepare("SELECT base_url, model FROM sessions_accounts LIMIT 0").get(); } catch { db.exec(ACCOUNTS_ENDPOINT_MIGRATION); }
    // A provider with exactly one account has it as its default (earlier installs left it unset).
    try { db.exec("UPDATE sessions_accounts SET is_default = 1 WHERE is_default = 0 AND provider IN (SELECT provider FROM sessions_accounts GROUP BY provider HAVING COUNT(*) = 1)"); } catch {}
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
    const PROVIDERS = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "grok", label: "Grok" }, { id: "openrouter", label: "OpenRouter" }, { id: "openai-compatible", label: "OpenAI-compatible" }];
    // Codex (through codex-acp) and Grok (its own ACP mode) run on the one generic ACP driver, each
    // with strictest-approval flags at every start and its own sign-in in the account's HOME.
    const acpSessions = provider => ({
      get: id => { const r = /** @type {any} */ (db.prepare("SELECT agent_session FROM sessions_acp WHERE thread = ? AND provider = ?").get(String(id), provider)); return r ? String(r.agent_session) : undefined; },
      set: (id, a) => { db.prepare("INSERT INTO sessions_acp (thread, provider, agent_session) VALUES (?,?,?) ON CONFLICT(thread) DO UPDATE SET agent_session = excluded.agent_session").run(String(id), provider, String(a)); },
    });
    // The plain API-key chat driver, its conversation kept here so a resume carries on: OpenRouter, and "OpenAI-compatible" (any chat endpoint the person gives a
    // key and an address for, on the setup screen). Both share the one store, keyed by thread.
    const chatStore = {
      get: id => { const r = /** @type {any} */ (db.prepare("SELECT messages FROM sessions_openrouter WHERE thread = ?").get(String(id))); try { return r ? JSON.parse(String(r.messages)) : undefined; } catch { return undefined; } },
      set: (id, m) => { db.prepare("INSERT INTO sessions_openrouter (thread, messages) VALUES (?,?) ON CONFLICT(thread) DO UPDATE SET messages = excluded.messages").run(String(id), JSON.stringify(m)); } };
    // Every model call goes through the inference door (contract 8.4): ctx.model is the door, ctx.chainFor(o) the kernel chain of a session. With no door a
    // provider refuses to run unless VYRE_LEGACY_DIRECT_MODEL=1 (one warning per provider); see lib/door-bridge.js and team/archive/work-journals/door-retrofit.md.
    const doorCfg = { door: /** @type {any} */ (ctx).model, legacyDirect: process.env.VYRE_LEGACY_DIRECT_MODEL === "1", chainFor: /** @type {any} */ (ctx).chainFor, warn: m => { try { ctx.log ? ctx.log(m) : process.stderr.write(m + "\n"); } catch {} } };
    const drivers = { codex: loginDirect(codexProvider({ sessions: acpSessions("codex") }), doorCfg), grok: loginDirect(grokProvider({ sessions: acpSessions("grok") }), doorCfg),
      // The last rung: a plain API-key driver.
      openrouter: openrouterProvider({ ...doorCfg, ...(testBase(process.env.VYRE_OPENROUTER_URL) ? { baseUrl: process.env.VYRE_OPENROUTER_URL } : {}), store: chatStore }),
      "openai-compatible": openrouterProvider({ ...doorCfg, id: "openai-compatible", keyEnv: "OPENAI_COMPAT_API_KEY", baseUrl: "https://api.openai.com/v1", store: chatStore }) };
    for (const [name, driver] of Object.entries(drivers)) ctx.provider(name, driver);
    /** The models a provider's accounts last reported (most recent first wins), and the plan one account reported. */
    const providerModels = provider => {
      const r = /** @type {any} */ (db.prepare("SELECT models FROM sessions_provider_meta WHERE provider = ? AND models IS NOT NULL ORDER BY at DESC LIMIT 1").get(provider));
      try { return r ? JSON.parse(String(r.models)) : []; } catch { return []; }
    };
    const accountPlan = (provider, account) => {
      const r = /** @type {any} */ (db.prepare("SELECT plan FROM sessions_provider_meta WHERE provider = ? AND account = ?").get(provider, String(account)));
      return r && r.plan ? String(r.plan) : null;
    };
    // The Switchboard tells us what a session's provider said about itself (init: models, plan), so providers.list can fill a model picker. Internal.
    ctx.tool("sessions.providers.learn", {
      description: "Record what a provider reported in a session: the models its account can use (id, label) and its plan. For providers.list; not a public name.", internal: true,
      input: { type: "object", required: ["provider"], properties: { provider: str, account: str, models: { type: "array", maxItems: 200, items: { type: "object", required: ["id"], properties: { id: str, label: str } } }, plan: str } },
      run: async i => {
        const models = Array.isArray(i.models) && i.models.length ? JSON.stringify(i.models.map(m => ({ id: String(m.id).slice(0, 100), label: String(m.label || m.id).slice(0, 100) }))) : null;
        const plan = typeof i.plan === "string" && i.plan.trim() ? i.plan.trim().slice(0, 60) : null;
        if (!models && !plan) return { recorded: false };
        const acct = String(i.account || "");
        db.prepare(`INSERT INTO sessions_provider_meta (provider, account, models, plan, at) VALUES (?,?,?,?,?)
          ON CONFLICT(provider, account) DO UPDATE SET models = COALESCE(excluded.models, models), plan = COALESCE(excluded.plan, plan), at = excluded.at`).run(String(i.provider), acct, models, plan, Date.now());
        return { recorded: true };
      },
    });
    ctx.tool("sessions.providers.snapshot", {
      description: "Every session provider this module speaks for (claude, codex, grok), each with its own accounts and the models it offers. For providers.list (core/providers) to assemble; not a public name itself.", internal: true,
      input: { type: "object", properties: {} },
      run: async () => Promise.all(PROVIDERS.map(async p => ({ ...p,
        accounts: await Promise.all(accounts.list(p.id).map(async a => ({ id: a.id, label: a.label, kind: a.kind, plan: accountPlan(p.id, a.id), ...(p.id === "grok" ? { privacy: a.privacy } : {}), signed_in: a.kind === "login" ? (a.synthetic ? true : a.signed_in_at != null) : !a.vault_item ? true : (await vaultHas(a.vault_item)) !== false, default: a.is_default }))),
        models: p.id === "claude" ? MODEL_ALIASES : providerModels(p.id),
        capabilities: p.id === "claude" ? { streaming: true, resume: true, interrupt: true, modes: true, questions: true, transcripts: true } : /** @type {any} */ (drivers)[p.id].capabilities }))),
    });

    // ---- the "@" picker's Accounts kind: the AI accounts that are signed in, so "@codex" picks who answers one turn
    /** Is this account one a turn could run on now: not waiting on a person, and signed in or holding its key. @param {any} a */
    const signedIn = async a => !a.pending && (a.kind === "login" ? (a.synthetic ? true : a.signed_in_at != null) : !a.vault_item ? true : (await vaultHas(a.vault_item)) !== false);
    /** One row per signed-in account: the provider's own name when it has one, "Name (label)" when it has several. */
    const accountChoices = async () => {
      const out = [];
      for (const p of PROVIDERS) {
        const ok = [];
        for (const a of accounts.list(p.id)) if (await signedIn(a)) ok.push(a);
        for (const a of ok) out.push({ kind: "account", id: ok.length === 1 ? p.id : `${p.id}:${a.id}`, name: ok.length === 1 ? p.label : `${p.label} (${a.label})`, hint: `${p.label} account, ${a.kind === "login" ? "signed in" : a.kind}`, provider: p.id, account: ok.length === 1 ? null : a.id });
      }
      return out;
    };
    tool("sessions.mention.search", "The @ picker's Accounts results: the AI accounts that are signed in (Claude, Codex, Grok, OpenRouter), by provider name. Names and a short hint only.",
      { type: "object", properties: { q: str, limit: { type: "integer", minimum: 1, maximum: 50 } } },
      async i => {
        const q = String(i.q || "").trim().toLowerCase();
        const rows = (await accountChoices()).filter(r => !q || r.name.toLowerCase().includes(q) || r.provider.includes(q));
        return rows.slice(0, i.limit || 12).map(({ provider: _p, account: _a, ...r }) => r);
      });
    tool("sessions.mention.resolve", "What an account tagged with @ means for a thread: the person asked this one turn to run on it. No grant; threads.send reads the tag. Called by the mentions core.",
      { type: "object", required: ["id"], properties: { id: str, thread: str, said: str } },
      async i => {
        const hit = (await accountChoices()).find(r => r.id === String(i.id));
        if (!hit) throw Object.assign(new Error("that account is not signed in"), { code: "not_found" });
        return { name: hit.name, hint: hit.hint, outside: false, note: `The person asked ${hit.name} to answer this one turn. The session keeps its own provider.` };
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

    /** @type {Map<string, { email?: string, org?: string } | null>} */ const identities = new Map();
    /** @type {Map<string, number>} */ const identityAt = new Map();
    /** @param {any} a an account row */
    const identityOf = async a => {
      const key = `${a.id}:${a.signed_in_at}`;
      // A found identity is kept; an empty one is asked again after a few seconds (Claude Code writes oauthAccount only once it has run, so a
      // first read right after sign-in is often empty and must not stay empty for good).
      const had = identities.get(key);
      if (had) return had;
      if (identities.has(key) && Date.now() - (identityAt.get(key) || 0) < 15_000) return null;
      let out = null;
      try {
        if (usesSpawner() && a.uid != null) {
          const acctHome = path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct", String(a.uid));
          const child = spawnSession(process.execPath, [fileURLToPath(new URL("./identity.js", import.meta.url)), a.provider, acctHome], { cwd: acctHome, env: { PATH: process.env.PATH, HOME: acctHome }, account: { uid: a.uid, shared: false } });
          let buf = "";
          child.stdout && child.stdout.on("data", d => { buf += d; });
          await new Promise(r => { const t = setTimeout(r, 5000); child.on("close", () => { clearTimeout(t); r(undefined); }); child.on("error", () => { clearTimeout(t); r(undefined); }); });
          try { out = JSON.parse(buf.trim().split("\n").pop() || "null"); } catch { out = null; }
        } else {
          out = readIdentity(a.provider, path.join(root, "accounts", String(a.id)));
        }
      } catch { out = null; }
      identities.set(key, out);
      identityAt.set(key, Date.now());
      return out;
    };
    tool("sessions.accounts.list", "Every account on a provider, or every account on every provider. Each names a vault item (never a value) and its scope: which projects and agents it is granted to.",
      { type: "object", properties: { provider: str } },
      async (i, meta) => {
        const listed = accounts.list(i.provider ? String(i.provider) : undefined);
        // Who a signed-in login account is signed in as (the non-secret email and org its own login left), so the person's confirm of an account the
        // assistant started can tell whose it is; null reads as "account not identified".
        const PRIVACY_ON = "Privacy mode on: xAI does not keep this account's sessions; Grok cannot make video.";
        const PRIVACY_OFF = "Privacy mode off: xAI keeps this account's sessions and may train on them; Grok can make video.";
        const rows = await Promise.all(listed.map(async a0 => { const a = a0.provider === "grok" && !a0.synthetic ? { ...a0, privacy_label: a0.privacy ? PRIVACY_ON : PRIVACY_OFF, privacy_note: "Change it in Grok's /privacy settings; Vyre shows what you chose." } : a0;
          return a.kind === "login" && !a.synthetic && a.signed_in_at != null ? { ...a, identity: await identityOf(a) } : a; }));
        // Vault item names go to people, modules and the assistant; another agent sees the accounts without them.
        const seesItems = !meta || !meta.agent || /** @type {any} */ (meta).agentKind === "assistant";
        return seesItems ? rows : rows.map(({ vault_item, identity, ...r }) => r);
      });

    /** The project the request came from: the calling session's own thread's project, or null. @param {any} meta */
    const requestProject = async meta => {
      const th = meta && typeof meta.thread === "string" ? await ctx.call("threads.get", { thread: meta.thread, limit: 1 }).catch(() => null) : null;
      const p = th && th.data && th.data.thread && th.data.thread.project;
      return p ? String(p) : null;
    };
    // A provider account signing in or out is announced as account.changed (the onboarding module's assistant check listens): { provider, account, signed_in, why }. Announced only when the
    // account's usability changed, never for a label or scope edit, and never carrying anything of the credential.
    const accountChanged = (/** @type {any} */ row, /** @type {boolean} */ signedIn, /** @type {string} */ why) => {
      if (!row) return;
      try { ctx.events.emit("account.changed", { provider: String(row.provider), account: String(row.id), signed_in: signedIn, why }); } catch { /* an emit never fails the call */ }
    };
    tool("sessions.accounts.add", `Add an account: a label, its kind, and for an api-key or setup-token the vault item that already holds its credential (add it in the Vault first and grant it to threads; this never touches its value). kind login has no vault item: the provider's own sign-in fills that account's private home. scope is { projects: "*"|[slugs], agents: "*"|[names] }, default "*" (every project and agent may use it until it is bound narrower). is_default makes it the provider's pick when nothing else resolves. Each account runs as its own user on a server, so one account's sign-in is unreadable from another's.`,
      { type: "object", required: ["provider", "label"], properties: { provider: str, label: str, kind: { type: "string", enum: ACCOUNT_KINDS }, vault_item: str,
        scope: { type: "object", properties: { projects: {}, agents: {} } }, is_default: { type: "boolean" } } },
      async (i, meta) => {
        askedOnly(meta, "Adding an account", { assistant: true });
        // Not a person's surface: the account covers only the project the request came from, never every project, and is pending
        // (unusable) until the person finishes it on their own device (a login's sign-in, or their bind of a key's account).
        const byPerson = isPerson(meta || {});
        if (!byPerson) {
          const project = await requestProject(meta);
          i = { ...i, scope: { projects: project ? [project] : [], agents: i.scope && i.scope.agents !== undefined ? i.scope.agents : "*" }, is_default: false, pending: true };
        }
        if (i.kind !== "login" && i.vault_item && (await vaultHas(String(i.vault_item))) === false) throw Object.assign(new Error(`the vault has no item ${i.vault_item}; add the credential there first`), { code: "bad_input" }); 
        const added = accounts.add(i);
        // A key or setup-token account the person adds is usable at once; a login is announced when its sign-in ends, a pending one when the person finishes it (bind).
        if (i.kind !== "login" && !i.pending) accountChanged(await added, true, "added");
        return added;
      }, ASSISTANT);

    // ---- signing in (each provider's own login, run as the account; Vyre never sees the token)
    const signins = new Signins({ spawn: (bin, args, { account }) => {
      // On a box the spawner puts the account's uid and HOME in place. Elsewhere a provider that
      // keeps its login in HOME gets one private folder per account.
      const home = usesSpawner() ? undefined : path.join(root, "accounts", String(account.id));
      if (home) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const acctHome = usesSpawner() ? path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct", String(account.uid)) : /** @type {string} */ (home);
      return spawnSession(bin, args, { cwd: acctHome, env: { PATH: process.env.PATH, ...(home ? { HOME: home } : {}), TERM: "dumb", NO_COLOR: "1", BROWSER: "none" }, ...(usesSpawner() && account.uid != null ? { account: { uid: account.uid, shared: false } } : {}) });
    } });
    // ---- an API key instead of a login: "Sign in to your AI" on the setup screen takes one of three kinds. The key goes into the Vault (never shown again), is checked with
    // one cheap read-only call to the address it will be used with, and becomes an api-key account bound to that address.
    const KEY_KINDS = /** @type {Record<string, { provider: string, label: string, base: string|null, custom: boolean }>} */ ({
      "openai-compatible": { provider: "openai-compatible", label: "OpenAI-compatible", base: "https://api.openai.com/v1", custom: true },
      "anthropic-compatible": { provider: "claude", label: "Anthropic-compatible", base: "https://api.anthropic.com", custom: true },
      openrouter: { provider: "openrouter", label: "OpenRouter", base: "https://openrouter.ai/api/v1", custom: false },
    });
    /** One cheap, read-only call that proves the key works at the address (no model is run, nothing is spent). Redirects are refused so the key never follows one elsewhere. */
    const checkKey = async (/** @type {string} */ kind, /** @type {string} */ base, /** @type {string} */ key) => {
      const url = kind === "anthropic-compatible" ? `${base.replace(/\/v1$/, "")}/v1/models` : kind === "openrouter" ? "https://openrouter.ai/api/v1/auth/key" : `${base}/models`;
      const headers = kind === "anthropic-compatible" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15_000);
      try {
        const pin = await resolveSafe(url);
        if (!pin) throw Object.assign(new Error("that address is not a place a key may be sent"), { code: "bad_input" });
        const r = await pinnedFetch(url, { headers, signal: ac.signal }, pin);
        // The answer is read for nothing; a server that streams without end is cut off after about 1 MB.
        if (r.body) { let n = 0; for await (const c of /** @type {any} */ (r.body)) { n += c.length; if (n > 1_000_000) { ac.abort(); break; } } }
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error("the service refused that key"), { code: "bad_input" });
        if (!r.ok) throw Object.assign(new Error(`the service answered ${r.status} when the key was checked`), { code: "bad_input" });
      } catch (e) {
        if (/** @type {any} */ (e).code === "bad_input") throw e;
        throw Object.assign(new Error(/** @type {any} */ (e).name === "AbortError" ? "the service did not answer in time" : "could not reach the service to check the key"), { code: "bad_input" });
      } finally { clearTimeout(timer); }
    };
    tool("sessions.accounts.key", "Add an AI account from an API key: kind openai-compatible (key and base_url), anthropic-compatible (key and base_url) or openrouter (key). The key is checked with one cheap call, stored in the Vault (bound to that address) and never returned or shown again; the key is sent only to that host, which is looked up again on every turn and refused if it points at a private, tailnet or metadata address. Removing the account removes the key. Only the person (or their own words) adds one.",
      { type: "object", required: ["kind", "key"], properties: { kind: { type: "string", enum: Object.keys(KEY_KINDS) }, key: str, base_url: str, model: str, label: str } },
      async (i, meta) => {
        askedOnly(meta, "Adding an API key");
        const k = KEY_KINDS[String(i.kind)];
        if (!k) throw Object.assign(new Error("kind is openai-compatible, anthropic-compatible or openrouter"), { code: "bad_input" });
        const key = String(i.key || "").trim();
        if (key.length < 12 || key.length > 400 || /[\s\u0000-\u001f\u007f]/.test(key)) throw Object.assign(new Error("that does not look like an API key"), { code: "bad_input" });
        const base = k.custom ? endpointOk(i.base_url || k.base) : /** @type {string} */ (k.base);
        if (!k.custom && i.base_url) throw Object.assign(new Error("OpenRouter has one address; leave base_url out"), { code: "bad_input" });
        await checkKey(String(i.kind), base, key);
        const id = crypto.randomBytes(6).toString("hex");
        const item = `ai-key-${k.provider}-${id}`;
        const put = await ctx.call("vault.put", { name: item, kind: "api-key", description: `${k.label} API key for ${new URL(base).host}`, value: key, hosts: [new URL(base).origin], grants: ["threads", "agents"] });
        if (put.error) throw Object.assign(new Error(put.error.code === "no_such_tool" ? "the Vault is not running on this machine" : "the Vault would not take the key"), { code: "bad_input" });
        const label = String(i.label || "").trim().slice(0, 60) || `${k.label} (${new URL(base).host})`;
        const row = await accounts.add({ provider: k.provider, label, kind: "api-key", vault_item: item, ...(k.custom ? { base_url: base } : {}), ...(i.model ? { model: String(i.model).slice(0, 100) } : {}) });
        accountChanged(row, true, "key");
        return { account: row.id, provider: row.provider, label: row.label, checked: true, host: new URL(base).host, ...(row.model ? { model: row.model } : {}) };
      });
    tool("sessions.accounts.signin", `Sign an account in with its provider's own login (Codex --device-auth, Grok Build's device code, Claude's login), no token pasted or copied. Start: { provider, label? } makes a login account (or { account } for one that exists) and answers { flow, step: "code", url, code } to show; the person approves on any browser. Then { flow } says waiting, done or failed; for a login that wants a code back ({ step: "url", paste: true }) send { flow, code }. The token is written by the provider's own command into that account's private home; Vyre never reads it.`,
      { type: "object", properties: { provider: str, label: str, account: str, flow: str, code: str } },
      async (i, meta) => {
        askedOnly(meta, "Signing in an account", { assistant: true });
        const byPerson = isPerson(meta || {});
        if (i.flow && i.code) return signins.submit(String(i.flow), String(i.code));
        if (i.flow) return signins.status(String(i.flow));
        const provider = String(i.provider || "");
        if (!LOGINS[provider] || !PROVIDERS.some(p => p.id === provider)) throw Object.assign(new Error(`there is no sign-in for ${provider || "that provider"}`), { code: "bad_input" });
        if (provider === "claude" && !usesSpawner()) throw Object.assign(new Error("on this machine Claude uses the login already on it (run claude and sign in there)"), { code: "bad_input" });
        let row = i.account ? accounts.row(String(i.account)) : null;
        if (i.account && (!row || row.provider !== provider || row.kind !== "login")) throw Object.assign(new Error("that is not a login account on this provider"), { code: "bad_input" });
        // A non-person starts a sign-in only for a new account, or one still pending: it never re-signs-in a working account.
        if (!byPerson && row && !row.pending) throw Object.assign(new Error("only the person signs a working account in again"), { code: "denied" });
        const created = !row;
        if (!row) {
          const project = byPerson ? null : await requestProject(meta);
          row = await accounts.add({ provider, label: String(i.label || PROVIDERS.find(p => p.id === provider)?.label || provider), kind: "login",
            ...(byPerson ? {} : { scope: { projects: project ? [project] : [], agents: "*" }, pending: true }) });
        }
        const account = row;
        try { return await signins.start({ provider, account, onDone: ok => { if (ok) { accounts.markSignedIn(account.id); accountChanged(accounts.row(account.id), true, "signed_in"); ctx.call("threads.providers.learn", { provider, account: account.id }).catch(() => {}); } else if (created && accounts.row(account.id) && !accounts.row(account.id).signed_in_at) accounts.remove(account.id); } }); }
        catch (e) { if (created) accounts.remove(account.id); throw e; }
      }, ASSISTANT);

    tool("sessions.accounts.remove", "Remove an account. Threads already resumed on it keep running; the next resume on that thread asks for another (a removed account is never a silent fallback).",
      { type: "object", required: ["id"], properties: { id: str } },
      async (i, meta) => {
        if (!isPerson(meta || {})) throw Object.assign(new Error("removing an account is the person's own, on their own surface"), { code: "denied" });
        const row = accounts.row(String(i.id));
        const out = accounts.remove(i.id);
        if (row && !row.pending) accountChanged(row, false, "removed");
        // A key this module vaulted goes with its account (the Vault refuses to delete anything else of ours).
        if (row && row.kind === "api-key" && /^ai-key-/.test(String(row.vault_item || ""))) await ctx.call("vault.delete", { name: row.vault_item }).catch(() => {});
        return out;
      });

    tool("sessions.accounts.bind", "Grant an account to one more project or agent (added to its scope, others it already has kept), or make it its provider's default.",
      { type: "object", required: ["id"], properties: { id: str, project: str, agent: str, is_default: { type: "boolean" } } },
      async (i, meta) => {
        askedOnly(meta, "Binding an account", { assistant: true });
        if (isPerson(meta || {})) {
          const was = accounts.row(String(i.id)), bound = accounts.bind({ ...i, confirm: true });
          const now = await bound;
          if (was && was.pending && now && !now.pending && !(now.kind === "login" && now.signed_in_at == null)) accountChanged(now, true, "confirmed");
          return bound;
        }
        // Not a person's surface: only to the project the request came from, never "*", an agent or a default; it never finishes a pending account.
        const project = await requestProject(meta);
        if (!project || i.project !== project || i.agent || i.is_default) throw Object.assign(new Error("outside a person's surface an account is bound only to the project the request came from; a wider scope is set from the person's own surface"), { code: "denied" });
        return accounts.bind({ id: i.id, project });
      }, ASSISTANT);

    // A file a provider left in an account's own folder (Grok Build's generated images are 0600 there), read as that account and returned as base64, for
    // the Switchboard to hand to artifacts. Internal: only Vyre's modules call it. The read runs as the account's uid on a box.
    const MEDIA_MAX = 20 * 1024 * 1024;
    ctx.tool("sessions.files.read", {
      description: "Read one regular file from inside an account's own folder, as that account (`file` is relative to the account's HOME, under a provider's own folder such as .grok or .codex, no links, at most 20 MB). Answers { size, sha256, data_b64 }. Not a public name.", internal: true,
      input: { type: "object", required: ["account", "file"], properties: { account: str, file: str } },
      run: async i => {
        const a = accounts.row(String(i.account));
        if (!a) throw Object.assign(new Error(`no account ${i.account}`), { code: "not_found" });
        // Relative on purpose: the floor refuses any path inside Vyre's own home in a call's input, and on a Mac an account's HOME is there; the provider's
        // own folder (.grok, .codex) is the only place a generated file is read from, and nothing else of the HOME.
        const rel = String(i.file);
        if (path.isAbsolute(rel) || rel.includes("\0") || rel.split("/").includes("..") || !/^\.(?:grok|codex)\//.test(rel)) throw Object.assign(new Error("file must be a path under .grok or .codex in the account's folder"), { code: "bad_input" });
        const home = usesSpawner() && a.uid != null ? path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct", String(a.uid)) : path.join(root, "accounts", String(a.id));
        const child = spawnSession(process.execPath, [fileURLToPath(new URL("./readfile.js", import.meta.url)), home, path.join(home, rel), String(MEDIA_MAX)],
          { cwd: home, env: { PATH: process.env.PATH, HOME: home }, ...(usesSpawner() && a.uid != null ? { account: { uid: a.uid, shared: false } } : {}) });
        /** @type {Buffer[]} */ const chunks = [];
        let size = 0, err = "";
        child.stderr && child.stderr.on("data", d => { err = (err + d).slice(-300); });
        child.stdout.on("data", d => { size += d.length; if (size <= MEDIA_MAX) chunks.push(d); });
        const code = await new Promise(r => { child.on("close", c => r(c)); child.on("error", () => r(127)); });
        if (code !== 0 || size > MEDIA_MAX) throw Object.assign(new Error(err.trim() || "the file could not be read"), { code: "denied" });
        const bytes = Buffer.concat(chunks);
        return { size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), data_b64: bytes.toString("base64") };
      },
    });
    // The person's choice about whether xAI keeps this Grok account's sessions (and so whether Grok can make video). The setting itself lives on xAI's side for the
    // account and is changed there (in Grok's own /privacy settings); this records what the person chose so Vyre says it plainly and a surface can offer the choice.
    tool("sessions.accounts.set", "Set an account's privacy choice (Grok only): privacy true is privacy mode on, xAI does not keep the account's sessions and Grok cannot make video; false is off, xAI keeps them and may train on them, and Grok can make video. Records the choice; the setting itself is changed on xAI's side, in Grok's /privacy settings.",
      { type: "object", required: ["account", "privacy"], properties: { account: str, privacy: { type: "boolean" } } },
      async i => accounts.setPrivacy(String(i.account), Boolean(i.privacy)));
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

    /**
     * The environment brief for one agent (environment.js), from live reads: what it can reach (the registry's own list for its caller class), the Space and the others the person
     * belongs to, the record types, the connectors, the team. Each read is optional: one that fails drops its line. Spaces come from spaces.brief and the types from work.space-brief (the person's own tools refuse a module); a build
     * whose kernel does not answer says "ask records.types" instead of listing them.
     * @param {{ agent?: string, agent_kind?: string, project?: string, provider?: string }} i
     */
    const environment = async i => {
      const label = i.agent ? `mcp:agent:${i.agent}` : "mcp";
      const ok = (/** @type {any} */ r) => (r && !r.error ? r.data : null);
      let names = [];
      try { names = (ctx.modules.tools(label) || []).map((/** @type {any} */ t) => String(t.name)); } catch { names = []; }
      // An assistant does what its person can: the person-reach tools the agent rules leave open are its too.
      if (i.agent_kind === "assistant") { try { const all = new Set((ctx.modules.tools("cli") || []).map((/** @type {any} */ t) => String(t.name))); for (const t of AGENT_OPEN) if (all.has(t) && !names.includes(t)) names.push(t); } catch { /* none */ } }
      const [agent, sp, ty, mcp, team] = await Promise.all([i.agent ? ctx.call("agents.list", {}).then(ok, () => null) : null, ctx.call("spaces.brief", {}).then(ok, () => null), ctx.call("work.space-brief", {}).then(ok, () => null),
        ctx.call("mcp.servers", {}).then(ok, () => null), ctx.call("team.list", {}).then(ok, () => null)]);
      // The brief is cut to the asking agent (ENV-1): only the identity-level assistant, or the person's own session, is told of every Space, connector and teammate. Any other agent hears of the current Space,
      // the connectors it holds a tool of, and the teammates only if it may list them; a read that cannot be cut to the agent is dropped.
      const scoped = Boolean(i.agent) && i.agent_kind !== "assistant";
      const spaces = (sp && Array.isArray(sp.spaces) ? sp.spaces : []).filter((/** @type {any} */ x) => !scoped || x.current).map((/** @type {any} */ x) => ({ name: String(x.name || ""), role: x.role || null, current: Boolean(x.current), zone: typeof x.zone === "string" ? x.zone : null })).filter((/** @type {any} */ x) => x.name);
      const types = ty && Array.isArray(ty.types) ? ty.types.map((/** @type {any} */ t) => ({ name: String(t.name), fields: Array.isArray(t.fields) ? t.fields.map((/** @type {any} */ f) => String(f.name || f)) : [] })) : null;
      const a = (Array.isArray(agent) ? agent : agent && Array.isArray(agent.agents) ? agent.agents : []).find((/** @type {any} */ x) => x && x.name === i.agent);
      // The person's zone is the device's (the launch's `zone`); the space's is its setting (spaces.brief); an unknown person zone falls back to the space's, then UTC, and the line says so by naming it.
      const here = spaces.find((/** @type {any} */ x) => x.current);
      const spaceZone = zoneFrom(i.space_zone || (here && here.zone), "") || null;
      const personZone = zoneFrom(i.zone, spaceZone || "UTC");
      const timeText = timeLine({ now: Number.isFinite(Number(i.now)) ? Number(i.now) : Date.now(), person: personZone, space: spaceZone, contacts: Array.isArray(i.contacts) ? i.contacts : [] });
      return environmentOf({
        timeLine: timeText,
        agent: i.agent ? { name: i.agent, kind: i.agent_kind || null, projects: a && (a.projects === "*" || Array.isArray(a.projects)) ? a.projects : undefined } : null,
        project: i.project || null, provider: i.provider || "claude", tools: names, spaces, space: spaces.find((/** @type {any} */ x) => x.current) || null, types,
        connectors: (Array.isArray(mcp) ? mcp : []).filter((/** @type {any} */ c) => !scoped || names.some(n => n.startsWith(`${c.name}.`) || n.startsWith(`${c.name}_`) || n.startsWith(`mcp__${c.name}__`))).map((/** @type {any} */ c) => ({ name: c.name, state: c.state })),
        team: scoped && !names.includes("team.list") ? [] : (Array.isArray(team) ? team : team && Array.isArray(team.teammates) ? team.teammates : []).map((/** @type {any} */ x) => ({ name: x.name, role: x.role })),
        artifactsDir: i.artifacts_dir ? String(i.artifacts_dir) : null,
      });
    };
    ctx.tool("sessions.environment", {
      description: "The environment brief an agent starting now is told (what Vyre is, its Space, its records, how to work, approvals, memory, what it can reach), built from live reads and cut to a budget. The same text goes to every model and driver.", internal: true,
      input: { type: "object", properties: { agent: str, agent_kind: str, project: str, provider: str, artifacts_dir: str, zone: str, space_zone: str, now: { type: "number" }, contacts: { type: "array", items: { type: "object" } } } },
      run: async i => environment(i),
    });

    ctx.tool("sessions.prompt.compose", {
      description: "The system prompt for a session starting now: the environment brief, then the levels around Vyre's own launch text, then the project's own context (context, for a driver with no SessionStart hook). purpose \"capsule\" is the Capsule's quick answer (Vyre IQ): the whole prompt, with append read as its facts.", internal: true,
      input: { type: "object", properties: { agent: str, agent_kind: str, project: str, append: str, purpose: str, facts: { type: "array", items: str }, provider: str, context: str, artifacts_dir: str, zone: str, space_zone: str, now: { type: "number" }, contacts: { type: "array", items: { type: "object" } } } },
      run: async i => i.purpose === "capsule"
        ? (r => ({ ...r, text: `${r.text}\n\n${timeLine({ now: Number.isFinite(Number(i.now)) ? Number(i.now) : Date.now(), person: zoneFrom(i.zone, zoneFrom(i.space_zone, "UTC")), space: zoneFrom(i.space_zone, "") || null, contacts: Array.isArray(i.contacts) ? i.contacts : [] })}` }))(composeIq({ facts: Array.isArray(i.facts) ? i.facts.map(String) : factsFrom(i.append), own: prompts.current("capsule") }))
        : prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null, append: i.append || null, environment: (await environment(i)).text, context: i.context || null }),
    });

    return { async stop() { clearInterval(sweeper); signins.stop(); } };
  },
};
