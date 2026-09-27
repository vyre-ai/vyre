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
import { sessionsConfig, sdkDir, claudeBin, configModel, PURPOSES } from "./config.js";

/** Per-purpose and per-project model overrides a person set from a surface. */
const MODELS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_models (scope TEXT PRIMARY KEY, model TEXT NOT NULL, by TEXT, at INTEGER NOT NULL)`;
const MODEL = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
import { installed, install, VERSION, DOWNLOAD_MB } from "./sdk.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const scope = { type: "string", description: "assistant, agent:<name> or project:<slug>" };

export default {
  async start(ctx) {
    ctx.store.migrate([PROMPTS_MIGRATION, MODELS_MIGRATION]);
    const db = ctx.store.db;
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

    tool("sessions.prompt.preview", "The system prompt a session would start with, for an agent and a project: the levels used and how they combine. Without Vyre's own launch text, which the Switchboard adds.",
      { type: "object", properties: { agent: str, agent_kind: str, project: str } },
      async i => prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null }));

    tool("sessions.models.get", "What each kind of session runs on: the model per purpose (chat, agent, project, capsule, job, memory, planner, learn) and per project, and where each comes from. An agent's own model (agents.update) wins over these.",
      { type: "object", properties: {} },
      async () => ({ purposes: Object.fromEntries(PURPOSES.map(p => [p, modelFor({ purpose: p })])),
        projects: Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT scope, model FROM sessions_models WHERE scope LIKE 'project:%'").all()).map(r => [String(r.scope).slice(8), String(r.model)])) }));

    tool("sessions.models.set", "Set the model for a purpose (purpose:<chat|agent|project|capsule|job|memory|planner|learn>) or a project (project:<slug>): an alias (opus, sonnet, haiku) or a full model id. model null removes the override. Applies from the next session.",
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

    ctx.tool("sessions.prompt.compose", {
      description: "The system prompt for a session starting now: the levels around Vyre's own launch text.", internal: true,
      input: { type: "object", properties: { agent: str, agent_kind: str, project: str, append: str } },
      run: async i => prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null, append: i.append || null }),
    });

    return { async stop() {} };
  },
};
