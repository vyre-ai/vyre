// @ts-check
// Every setting a person can change, in one list. The Deck's Settings and `vyre config` are both
// drawn from it, so a key added here gets a control and a CLI route with no other work.
//
// levels: where it may be set. "project" beats "account", which beats the default.
// apply:  "live" (takes effect at once), "session" (from the next session) or "restart" (vyred
//         reads it at start; the Deck says so).
// owner:  C for Claude Code's own files (the terminal sees the same value), V for Vyre.
// store:  see stores.js. Keys keep the home they had before this module.

import { values, cfg, tool, claude } from "./stores.js";

export const PURPOSES = ["chat", "agent", "project", "capsule", "job", "memory", "planner", "learn"];
export const MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PUSH_KINDS = ["ask", "draft", "watch", "lesson", "planner"];

/**
 * @typedef {{ key: string, group: string, label: string, help?: string,
 *   type: "enum"|"bool"|"int"|"number"|"string"|"list"|"object"|"model", enum?: string[], choices?: number[], min?: number, max?: number,
 *   default?: any, levels: ("account"|"project")[], apply: "live"|"session"|"restart", owner: "V"|"C", advanced?: boolean,
 *   store: import("./stores.js").Store }} Def
 */

/** @type {(k: Omit<Def, "owner"|"store"> & { owner?: "V"|"C", store?: import("./stores.js").Store }) => Def} */
const def = k => ({ owner: "V", store: values(), ...k });

// The model per purpose lives in the sessions module (sessions_models); a project's model too.
const purposeModel = p => def({
  key: `model.${p}`, group: "models", label: `Model for ${p}`, type: "model", levels: ["account"], apply: "session",
  default: ["chat", "agent", "project"].includes(p) ? "opus" : "haiku",
  store: tool({
    get: () => ({ tool: "sessions.models.get", input: {}, pick: d => {
      const m = d && d.purposes && d.purposes[p];
      return m && String(m.from).startsWith("purpose:") ? m.model : undefined;
    } }),
    set: (_l, _p, v) => ({ tool: "sessions.models.set", input: { scope: `purpose:${p}`, model: v ?? null } }),
  }),
});

const pushKind = k => def({
  key: `notifications.${k}`, group: "notifications", label: `Notify for ${k}`, type: "bool", default: true, levels: ["account"], apply: "live",
  store: tool({
    get: () => ({ tool: "push.settings", input: {}, pick: d => d && d.kinds ? d.kinds[k] : undefined }),
    set: (_l, _p, v) => ({ tool: "push.settings", input: { kinds: { [k]: v ?? true } } }),
  }),
});

const plannerKey = (k, label, min) => def({
  key: `planner.${k}`, group: "planner", label, type: "int", min, levels: ["account"], apply: "live",
  store: tool({
    get: () => ({ tool: "planner.settings", input: {}, pick: d => d ? d[k] : undefined }),
    set: (_l, _p, v) => ({ tool: "planner.settings", input: v === undefined ? {} : { [k]: v } }),
  }),
});

/** @type {Def[]} */
export const KEYS = [
  // ---- Models and thinking ---------------------------------------------------------------------
  ...PURPOSES.map(purposeModel),
  def({ key: "model", group: "models", label: "Model for this project", help: "Beats the model per purpose; an agent's own model beats this.",
    type: "model", levels: ["project"], apply: "session",
    store: tool({ levels: ["project"],
      get: (_l, p) => ({ tool: "sessions.models.get", input: {}, pick: d => d && d.projects ? d.projects[String(p)] : undefined }),
      set: (_l, p, v) => ({ tool: "sessions.models.set", input: { scope: `project:${p}`, model: v ?? null } }) }) }),
  def({ key: "model.fallback", group: "models", label: "Fallback model", help: "Used when the main model is overloaded.", type: "model", levels: ["account", "project"], apply: "session" }),
  def({ key: "effort", group: "models", label: "Thinking effort", type: "enum", enum: EFFORTS, levels: ["account", "project"], apply: "session",
    help: "How hard Claude thinks before answering. Empty means the model's own default." }),
  def({ key: "thinking.show", group: "models", label: "Show thinking", type: "enum", enum: ["folded", "open", "hidden"], default: "folded", levels: ["account"], apply: "live" }),
  def({ key: "fast", group: "models", label: "Fast mode", type: "bool", default: false, levels: ["account", "project"], apply: "session" }),

  // ---- Permissions -----------------------------------------------------------------------------
  def({ key: "permissions.mode", group: "permissions", label: "Permission mode new sessions start in", type: "enum", enum: MODES, default: "default",
    levels: ["account", "project"], apply: "session", help: "Shift+Tab changes it for one session." }),
  def({ key: "permissions.allow", group: "permissions", label: "Always allow", help: "Rules like Bash(npm test:*) or Edit. The terminal uses the same list.",
    type: "list", levels: ["account", "project"], apply: "live", owner: "C", store: claude("permissions.allow") }),
  def({ key: "permissions.ask", group: "permissions", label: "Always ask", type: "list", levels: ["account", "project"], apply: "live", owner: "C", store: claude("permissions.ask") }),
  def({ key: "permissions.deny", group: "permissions", label: "Never allow", type: "list", levels: ["account", "project"], apply: "live", owner: "C", store: claude("permissions.deny") }),
  def({ key: "permissions.folders", group: "permissions", label: "Extra folders Claude may use", type: "list", levels: ["account", "project"], apply: "session",
    owner: "C", store: claude("permissions.additionalDirectories") }),

  // ---- Sessions ----------------------------------------------------------------------------------
  def({ key: "sessions.send_while_busy", group: "sessions", label: "When you send while Claude works", type: "enum", enum: ["steer", "queue", "interrupt"],
    default: "steer", levels: ["account", "project"], apply: "live", help: "Steer: Claude reads it at its next step. Alt+Enter does the other." }),
  def({ key: "sessions.tool_detail", group: "sessions", label: "Tool calls", type: "enum", enum: ["summary", "full"], default: "summary", levels: ["account"], apply: "live" }),
  def({ key: "sessions.checkpoints", group: "sessions", label: "Keep file checkpoints for rewind", type: "bool", default: true, levels: ["account", "project"], apply: "session" }),
  def({ key: "sessions.max_turns", group: "sessions", label: "Max turns per message", type: "int", min: 1, max: 1000, levels: ["account", "project"], apply: "session" }),
  def({ key: "sessions.budget_usd", group: "sessions", label: "Spend cap per session (USD)", type: "number", min: 0, levels: ["account", "project"], apply: "session" }),
  def({ key: "sessions.idle_minutes", group: "sessions", label: "Close an idle session after (minutes)", type: "int", min: 1, max: 1440, default: 10,
    levels: ["account"], apply: "live", store: cfg("sessions.idle_minutes") }),
  def({ key: "sessions.max_live", group: "sessions", label: "Sessions open at once on this machine", help: "0 means no cap.", type: "int", min: 0, max: 64,
    levels: ["account"], apply: "live", store: cfg("sessions.max_live") }),
  def({ key: "sessions.auth", group: "sessions", label: "How sessions sign in", type: "enum", enum: ["login", "setup-token", "api-key"],
    levels: ["account"], apply: "session", store: cfg("sessions.auth"), advanced: true }),
  def({ key: "sessions.output_style", group: "sessions", label: "Output style", type: "string", levels: ["account", "project"], apply: "session",
    owner: "C", store: claude("outputStyle") }),

  // ---- Teammates and concurrency (ADR 0031) ------------------------------------------------------
  def({ key: "team.preset", group: "teammates", label: "How much runs at once", type: "enum", enum: ["light", "balanced", "max", "custom"], default: "balanced",
    levels: ["account", "project"], apply: "live", help: "Light 1 teammate and 2 helpers, Balanced 3 and 4, Max 6 and 10." }),
  def({ key: "team.max_active", group: "teammates", label: "Teammates working at once", type: "int", min: 1, max: 8, levels: ["account", "project"], apply: "live" }),
  def({ key: "team.max_subagents", group: "teammates", label: "Helpers (subagents) at once", type: "int", min: 0, max: 16, levels: ["account", "project"], apply: "live" }),
  def({ key: "team.pause_at_warning", group: "teammates", label: "Pause when usage runs low", type: "bool", default: true, levels: ["account", "project"], apply: "live" }),
  def({ key: "limits.max_active_teammates", group: "teammates", label: "Box ceiling: teammates", type: "int", min: 1, max: 32, default: 6, levels: ["account"], apply: "live" }),
  def({ key: "limits.max_subagents", group: "teammates", label: "Box ceiling: helpers", type: "int", min: 0, max: 64, default: 8, levels: ["account"], apply: "live" }),

  // ---- Notifications and planner -----------------------------------------------------------------
  ...PUSH_KINDS.map(pushKind),
  def({ key: "notifications.planner_label", group: "notifications", label: "Show a planner item's words on the lock screen", type: "bool", default: false,
    levels: ["account"], apply: "live", store: tool({
      get: () => ({ tool: "push.settings", input: {}, pick: d => d ? d.planner_label : undefined }),
      set: (_l, _p, v) => ({ tool: "push.settings", input: { planner_label: Boolean(v) } }) }) }),
  plannerKey("escalate_after", "Ring again after (minutes)", 1),
  plannerKey("escalate_max", "Rings after the first", 0),
  plannerKey("event_lead", "Warn before an event (minutes)", 0),

  // ---- Memory and learning -----------------------------------------------------------------------
  def({ key: "memory.model", group: "memory", label: "Use a model to learn facts", type: "bool", default: true, levels: ["account"], apply: "restart", store: cfg("memory.model.on") }),
  def({ key: "memory.daily_usd", group: "memory", label: "Memory spend per day (USD)", type: "number", min: 0, default: 0.05, levels: ["account"], apply: "restart", store: cfg("memory.model.dailyUsd") }),
  def({ key: "learn.distill_daily", group: "memory", label: "Lessons distilled per day", type: "int", min: 0, max: 50, default: 6, levels: ["account"], apply: "restart", store: cfg("learn.distill.daily") }),
  def({ key: "recall.every", group: "memory", label: "Index new history every (minutes)", type: "int", min: 1, max: 1440, default: 5, levels: ["account"], apply: "restart", store: cfg("recall.every") }),

  // ---- Vault -------------------------------------------------------------------------------------
  def({ key: "vault.lock_idle", group: "vault", label: "Lock after idle", help: "Like 10m or 1h.", type: "string", default: "10m", levels: ["account"], apply: "restart", store: cfg("vault.lock.idle") }),
  def({ key: "vault.lock_max", group: "vault", label: "Lock after at most", type: "string", default: "12h", levels: ["account"], apply: "restart", store: cfg("vault.lock.max") }),
  def({ key: "vault.lock_on_sleep", group: "vault", label: "Lock when the Mac sleeps", type: "bool", default: true, levels: ["account"], apply: "restart", store: cfg("vault.lock.onSleep") }),
  def({ key: "vault.lock_on_screen_lock", group: "vault", label: "Lock when the screen locks", type: "bool", default: true, levels: ["account"], apply: "restart", store: cfg("vault.lock.onScreenLock") }),

  // ---- Files, terminal, tools --------------------------------------------------------------------
  def({ key: "projects.folder", group: "files", label: "Where new projects go", type: "string", levels: ["account"], apply: "restart", store: cfg("projectsDir") }),
  def({ key: "files.dotfiles", group: "files", label: "Show hidden files", type: "bool", default: false, levels: ["account"], apply: "restart", store: cfg("files.allowDot") }),
  def({ key: "terminal.keep_hours", group: "files", label: "Keep closed terminals for (hours)", type: "int", min: 0, max: 168, default: 12, levels: ["account"], apply: "restart", store: cfg("term.keep_hours") }),
  def({ key: "terminal.max", group: "files", label: "Terminals open at once", type: "int", min: 1, max: 64, default: 8, levels: ["account"], apply: "restart", store: cfg("term.max") }),
  def({ key: "mcp.idle", group: "tools", label: "Stop an unused MCP server after (minutes)", type: "int", min: 1, max: 1440, default: 10, levels: ["account"], apply: "restart", store: cfg("mcp.idle") }),
  def({ key: "tools.env", group: "tools", label: "Environment for sessions", help: "Names and values Claude's tools see. Keep secrets in the vault.",
    type: "object", levels: ["account", "project"], apply: "session", owner: "C", advanced: true, store: claude("env") }),
  def({ key: "tools.hooks", group: "tools", label: "Claude Code hooks", type: "object", levels: ["account", "project"], apply: "live", owner: "C", advanced: true, store: claude("hooks") }),
  def({ key: "tools.plugins", group: "tools", label: "Claude Code plugins on or off", type: "object", levels: ["account", "project"], apply: "session", owner: "C", advanced: true,
    store: claude("enabledPlugins") }),

  // ---- Glass, relay, Capsule ---------------------------------------------------------------------
  def({ key: "glass.handback_minutes", group: "devices", label: "Hand a computer back after (minutes idle)", help: "0 is never.", type: "int", choices: [0, 2, 5, 15],
    default: 5, levels: ["account"], apply: "live", store: cfg("computers.handbackIdleMin") }),
  def({ key: "relay.web_expiry_days", group: "devices", label: "Web links through the relay last (days)", type: "int", min: 1, max: 365, default: 30, levels: ["account"], apply: "live",
    store: cfg("relay.web_expiry_days") }),
  def({ key: "capsule.autostart", group: "devices", label: "Start the Capsule at login", type: "bool", default: false, levels: ["account"], apply: "restart", store: cfg("capsule.autostart") }),
];

export const BY_KEY = new Map(KEYS.map(k => [k.key, k]));

export const GROUPS = [
  ["models", "Models and thinking"], ["permissions", "Permissions"], ["sessions", "Sessions"], ["teammates", "Teammates"],
  ["notifications", "Notifications"], ["planner", "Planner"], ["memory", "Memory"], ["vault", "Vault"], ["files", "Files and terminal"],
  ["tools", "Tools"], ["devices", "Devices"],
];

/**
 * Check a value against its key. Returns the value to store (ints parsed from CLI strings).
 * undefined means "remove". Throws bad_input.
 * @param {Def} k @param {any} v
 */
export function coerce(k, v) {
  const bad = (/** @type {string} */ m) => { throw Object.assign(new Error(`${k.key}: ${m}`), { code: "bad_input" }); };
  if (v === null || v === undefined) return undefined;
  switch (k.type) {
    case "bool":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "on" || v === "yes") return true;
      if (v === "false" || v === "off" || v === "no") return false;
      return bad("expected true or false");
    case "int": case "number": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n) || (k.type === "int" && !Number.isInteger(n))) return bad(`expected ${k.type === "int" ? "a whole number" : "a number"}`);
      if (k.min !== undefined && n < k.min) return bad(`at least ${k.min}`);
      if (k.max !== undefined && n > k.max) return bad(`at most ${k.max}`);
      if (k.choices && !k.choices.includes(n)) return bad(`one of ${k.choices.join(", ")}`);
      return n;
    }
    case "enum":
      if (!k.enum || !k.enum.includes(String(v))) return bad(`one of ${(k.enum || []).join(", ")}`);
      return String(v);
    case "model":
      if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(String(v))) return bad("an alias like opus, sonnet or haiku, or a model id");
      return String(v);
    case "string":
      if (typeof v !== "string" || v.length > 4000) return bad("expected text");
      return v;
    case "list": {
      const list = Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean);
      if (list.some(x => typeof x !== "string" || x.length > 500) || list.length > 500) return bad("expected a list of text");
      return list;
    }
    case "object": {
      const o = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return bad("expected JSON"); } })() : v;
      if (!o || typeof o !== "object" || Array.isArray(o)) return bad("expected an object");
      return o;
    }
  }
  return bad("unknown type");
}
