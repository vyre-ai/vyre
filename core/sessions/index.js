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
import { sessionsConfig, sdkDir, claudeBin } from "./config.js";
import { installed, install, VERSION, DOWNLOAD_MB } from "./sdk.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const scope = { type: "string", description: "assistant, agent:<name> or project:<slug>" };

export default {
  async start(ctx) {
    ctx.store.migrate([PROMPTS_MIGRATION]);
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

    ctx.tool("sessions.prompt.compose", {
      description: "The system prompt for a session starting now: the levels around Vyre's own launch text.", internal: true,
      input: { type: "object", properties: { agent: str, agent_kind: str, project: str, append: str } },
      run: async i => prompts.compose({ agent: i.agent || null, agentKind: i.agent_kind || null, project: i.project || null, append: i.append || null }),
    });

    return { async stop() {} };
  },
};
