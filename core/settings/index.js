// @ts-check
// settings: one way to read and change every setting, at account or project level.
//
// The registry (registry.js) lists each key once; the Deck's Settings and `vyre config` are drawn
// from it. Keys stay where they always lived (stores.js), so this module decides only precedence
// and checking: a project's value beats the account's, which beats the default. A session's own
// chips (model, effort, mode) beat all three, but those live with the session, not here.
//
// Only a person changes settings (the Deck, the CLI, the Capsule). Agents may read them, since a
// session needs to know its own limits, and settings.resolve hands a starting session the Vyre
// values it should pass to the Agent SDK. Claude Code's own values (permission rules, hooks, env)
// are not in that answer: Claude Code reads its files itself.

import os from "node:os";
import path from "node:path";
import { KEYS, BY_KEY, GROUPS, coerce } from "./registry.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const MIGRATIONS = [
  `CREATE TABLE settings_values (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, by TEXT, at INTEGER,
     PRIMARY KEY (scope, key))`,
];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const str = { type: "string" };

/** The label another module sees when this one passes a person's change on. @param {string} caller */
const asPerson = caller => {
  const k = String(caller).replace(/[\s:]agent:.*$/s, "");
  return PEOPLE.includes(k) ? k : "deck"; // the owner's own Deck over the tailnet is "tailnet:<login>"
};

/** What a caller may see about one key, without its value. @param {import("./registry.js").Def} k */
const describe = k => ({
  key: k.key, group: k.group, label: k.label, ...(k.help ? { help: k.help } : {}), type: k.type,
  ...(k.enum ? { enum: k.enum } : {}), ...(k.choices ? { choices: k.choices } : {}),
  ...(k.min !== undefined ? { min: k.min } : {}), ...(k.max !== undefined ? { max: k.max } : {}),
  levels: k.levels, apply: k.apply, owner: k.owner, ...(k.advanced ? { advanced: true } : {}),
  ...(k.default !== undefined ? { default: k.default } : {}),
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const conf = () => (ctx.config && ctx.config.settings) || {};

    /** @type {import("./stores.js").Env} */
    const env = {
      db: ctx.store.db,
      root: ctx.paths.root,
      live: ctx.config,
      call: (tool, input, as) => (as ? ctx.call(tool, input, { as }) : ctx.call(tool, input)),
      claudeDir: () => conf().claude_dir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      projectHome: async slug => {
        const r = await ctx.call("projects.list", {});
        const list = r && r.data ? (Array.isArray(r.data) ? r.data : r.data.projects) : null;
        const p = Array.isArray(list) ? list.find(x => x && x.slug === slug) : null;
        return p ? String(p.home) : null;
      },
    };

    /** @param {string} key */
    const keyOf = key => {
      const k = BY_KEY.get(key);
      if (!k) throw Object.assign(new Error(`no setting ${key}; vyre config list shows them all`), { code: "not_found" });
      return k;
    };
    /** @param {any} project */
    const slugOf = project => {
      if (project == null || project === "") return null;
      if (!SLUG.test(String(project))) throw Object.assign(new Error("project is a project's slug"), { code: "bad_input" });
      return String(project);
    };

    /** One level's stored value, or undefined. A store that isn't there (a module off) says so. */
    const read = async (/** @type {any} */ k, /** @type {"account"|"project"} */ level, /** @type {string|null} */ project) => {
      if (!k.levels.includes(level) || (level === "project" && !project)) return { value: undefined };
      try { return { value: await k.store.read(env, level, project, k.key) }; }
      catch (e) { return { value: undefined, error: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message }; }
    };

    /** The value in effect and where it came from. @param {import("./registry.js").Def} k @param {string|null} project */
    const effective = async (k, project) => {
      const [p, a] = await Promise.all([read(k, "project", project), read(k, "account", project)]);
      const value = p.value !== undefined ? p.value : a.value !== undefined ? a.value : k.default;
      const source = p.value !== undefined ? "project" : a.value !== undefined ? "account" : k.default !== undefined ? "default" : "unset";
      const err = a.error || p.error;
      return {
        ...describe(k), value, source,
        ...(a.value !== undefined ? { account: a.value } : {}), ...(p.value !== undefined ? { project: p.value } : {}),
        available: err !== "unavailable",
        ...(err && err !== "unavailable" ? { problem: a.message || p.message } : {}),
      };
    };

    ctx.tool("settings.schema", {
      description: "Every setting Vyre has: key, group, label, type and choices, the levels it may be set at (account, project), when a change applies (live, next session, restart), and whether Claude Code's own files hold it (owner C).",
      input: { type: "object", properties: {} },
      run: async () => ({ groups: GROUPS.map(([id, label]) => ({ id, label })), keys: KEYS.map(describe) }),
    });

    ctx.tool("settings.get", {
      description: "Settings with the value in effect and where it comes from (project, account, default). Give key for one, group for a group, nothing for all; project to see a project's view.",
      input: { type: "object", properties: { key: str, group: str, project: str } },
      run: async i => {
        const project = slugOf(i.project);
        if (i.key) return effective(keyOf(i.key), project);
        const keys = KEYS.filter(k => !i.group || k.group === i.group);
        return { project, settings: await Promise.all(keys.map(k => effective(k, project))) };
      },
    });

    const change = async (/** @type {any} */ i, /** @type {string} */ caller, /** @type {any} */ value) => {
      const k = keyOf(i.key);
      const project = slugOf(i.project);
      const level = i.level || (project && k.levels.includes("project") ? "project" : "account");
      if (!k.levels.includes(level)) throw Object.assign(new Error(`${k.key} is set at ${k.levels.join(" or ")} level, not ${level}`), { code: "bad_input" });
      if (level === "project" && !project) throw Object.assign(new Error("a project setting needs project"), { code: "bad_input" });
      const v = value === undefined ? undefined : coerce(k, value);
      await k.store.write(env, level, level === "project" ? project : null, k.key, v, asPerson(caller), String(caller));
      ctx.events.emit("settings.changed", { key: k.key, level, ...(level === "project" ? { project } : {}), apply: k.apply });
      return effective(k, project);
    };

    ctx.tool("settings.set", {
      description: "Change a setting at account level, or for one project (give project). The value is checked against the setting's type. Returns the value now in effect.",
      input: { type: "object", required: ["key", "value"], properties: { key: str, value: {}, level: { type: "string", enum: ["account", "project"] }, project: str } },
      callers: PEOPLE,
      run: async (i, { caller }) => {
        if (i.value === null) throw Object.assign(new Error("use settings.reset to remove a value"), { code: "bad_input" });
        return change(i, caller, i.value);
      },
    });

    ctx.tool("settings.reset", {
      description: "Remove a setting's value at one level, so the level below (account, then default) applies again.",
      input: { type: "object", required: ["key"], properties: { key: str, level: { type: "string", enum: ["account", "project"] }, project: str } },
      callers: PEOPLE,
      run: async (i, { caller }) => change(i, caller, undefined),
    });

    ctx.tool("settings.resolve", {
      description: "The Vyre-owned values a session starting now in this project should use, as {key: value}. Unset keys are left out.",
      internal: true,
      input: { type: "object", properties: { project: str } },
      run: async i => {
        const project = slugOf(i.project);
        const rows = await Promise.all(KEYS.filter(k => k.owner === "V").map(k => effective(k, project)));
        return Object.fromEntries(rows.filter(r => r.value !== undefined).map(r => [r.key, r.value]));
      },
    });

    return { async stop() {} };
  },
};
