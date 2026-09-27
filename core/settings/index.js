// @ts-check
// settings: one way to read and change every setting, at account or project level.
//
// It holds no settings itself. Each module declares its own in module.json ("settings"; the
// shape and the stores are in core/config/settings.js), and this module serves the ones of
// running modules as tools, so the Deck's Settings and `vyre config` are drawn from one list. A
// project's value beats the account's, which beats the default. A session's own chips (model,
// effort, mode) beat all three, but those live with the session, not here.
//
// Only a person changes settings. A key that loosens security (security: "loosens") also needs a
// fresh presence proof; one that widens what Claude may do without asking (confirm) needs the
// caller to pass confirm: true after showing the person what changes. Agents may read settings,
// and settings.resolve hands a starting session its Vyre-owned values.

import os from "node:os";
import path from "node:path";
import { coerce, read, write, whereIs, needsConfirm } from "../config/settings.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const MIGRATIONS = [
  `CREATE TABLE settings_values (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, by TEXT, at INTEGER,
     PRIMARY KEY (scope, key))`,
];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const str = { type: "string" };

// How the groups a module names are shown, in order. A group no one declared doesn't appear; an
// unknown group goes last under its own name.
export const GROUPS = [
  ["models", "Models and thinking"], ["permissions", "Permissions"], ["sessions", "Sessions"], ["teammates", "Teammates"],
  ["notifications", "Notifications"], ["planner", "Planner"], ["memory", "Memory"], ["vault", "Vault"], ["files", "Files and terminal"],
  ["tools", "Tools"], ["devices", "Devices"],
];

/** The label another module sees when this one passes a person's change on. @param {string} caller */
const asPerson = caller => {
  const k = String(caller).replace(/[\s:]agent:.*$/s, "");
  return PEOPLE.includes(k) ? k : "deck"; // the owner's own Deck over the tailnet is "tailnet:<login>"
};

/** What a caller may see about one key, without its value. @param {any} d */
const describe = d => ({
  key: d.key, module: d.module, group: d.group || d.module, label: d.label, ...(d.help ? { help: d.help } : {}), type: d.type,
  ...(d.enum ? { enum: d.enum } : {}), ...(d.choices ? { choices: d.choices } : {}),
  ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}),
  levels: d.levels, apply: d.apply, owner: d.store && d.store.claude ? "C" : "V", ...(d.advanced ? { advanced: true } : {}),
  ...(d.security ? { security: d.security } : {}), ...(d.confirm ? { confirm: d.confirm } : {}), ...(d.loosens ? { loosens: d.loosens } : {}),
  ...(d.default !== undefined ? { default: d.default } : {}),
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const conf = () => (ctx.config && ctx.config.settings) || {};
    /** @returns {any[]} */
    const decls = () => (typeof ctx.declaredSettings === "function" ? ctx.declaredSettings() : []);

    /** @type {import("../config/settings.js").Env} */
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
    const declOf = key => {
      const d = decls().find(x => x.key === key);
      if (!d) throw Object.assign(new Error(`no setting ${key}; vyre config list shows them all`), { code: "not_found" });
      return d;
    };
    /** @param {any} project */
    const slugOf = project => {
      if (project == null || project === "") return null;
      if (!SLUG.test(String(project))) throw Object.assign(new Error("project is a project's slug"), { code: "bad_input" });
      return String(project);
    };

    /** One level's stored value, or undefined, and why it couldn't be read. */
    const level = async (/** @type {any} */ d, /** @type {"account"|"project"} */ lv, /** @type {string|null} */ project) => {
      if (!d.levels.includes(lv) || (lv === "project" && !project)) return { value: undefined };
      try { return { value: await read(env, d, lv, project) }; }
      catch (e) { return { value: undefined, error: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message }; }
    };

    /** The value in effect and where it came from. @param {any} d @param {string|null} project */
    const effective = async (d, project) => {
      const [p, a] = await Promise.all([level(d, "project", project), level(d, "account", project)]);
      const value = p.value !== undefined ? p.value : a.value !== undefined ? a.value : d.default;
      const source = p.value !== undefined ? "project" : a.value !== undefined ? "account" : d.default !== undefined ? "default" : "unset";
      const err = a.error || p.error;
      return {
        ...describe(d), value, source,
        ...(a.value !== undefined ? { account: a.value } : {}), ...(p.value !== undefined ? { project: p.value } : {}),
        available: err !== "unavailable",
        ...(err && err !== "unavailable" ? { problem: a.message || p.message } : {}),
      };
    };

    ctx.tool("settings.schema", {
      description: "Every setting the running modules declare: key, owning module, group, label, type and choices, the levels it may be set at (account, project), when a change applies (live, next session, restart), whether Claude Code's own files hold it (owner C), and whether changing it loosens security (a proof) or needs a confirm.",
      input: { type: "object", properties: {} },
      run: async () => {
        const keys = decls().map(describe);
        const known = new Map(GROUPS);
        const used = [...new Set(keys.map(k => k.group))];
        const groups = [...GROUPS.filter(([id]) => used.includes(id)), ...used.filter(g => !known.has(g)).map(g => [g, g])];
        return { groups: groups.map(([id, label]) => ({ id, label })), keys };
      },
    });

    ctx.tool("settings.get", {
      description: "Settings with the value in effect and where it comes from (project, account, default). Give key for one, group for a group, nothing for all; project to see a project's view.",
      input: { type: "object", properties: { key: str, group: str, project: str } },
      run: async i => {
        const project = slugOf(i.project);
        if (i.key) return effective(declOf(i.key), project);
        const list = decls().filter(d => !i.group || (d.group || d.module) === i.group);
        return { project, settings: await Promise.all(list.map(d => effective(d, project))) };
      },
    });

    const change = async (/** @type {any} */ i, /** @type {string} */ caller, /** @type {any} */ raw) => {
      // A caller vouched as an agent ("cli agent:kit", "mcp:agent:kit") is never the person,
      // whatever surface kind it rides on.
      if (/(?:^|[\s:])agent:/.test(String(caller))) throw Object.assign(new Error("settings are the person's own; an agent never changes one"), { code: "denied" });
      const d = declOf(i.key);
      const project = slugOf(i.project);
      const lv = i.level || (project && d.levels.includes("project") ? "project" : "account");
      if (!d.levels.includes(lv)) throw Object.assign(new Error(`${d.key} is set at ${d.levels.join(" or ")} level, not ${lv}`), { code: "bad_input" });
      if (lv === "project" && !project) throw Object.assign(new Error("a project setting needs project"), { code: "bad_input" });
      const value = raw === undefined ? undefined : coerce(d, raw);
      const target = lv === "project" ? project : null;
      const where = await whereIs(env, d, lv, target);
      const before = await level(d, lv, target);
      // What would change, for the person to see first. Nothing is written.
      if (i.preview) return { key: d.key, level: lv, ...(target ? { project: target } : {}), where, before: before.value, after: value,
        ...(needsConfirm(d, value) ? { confirm: d.loosens || `This lets Claude do more without asking: ${d.label}.` } : {}) };
      if (raw !== undefined && needsConfirm(d, value) && i.confirm !== true) {
        throw Object.assign(new Error(`${d.loosens || `This lets Claude do more without asking: ${d.label}.`} Show the person and send confirm: true.`), { code: "confirm_required" });
      }
      await write(env, d, lv, target, value, asPerson(caller), String(caller));
      ctx.events.emit("settings.changed", { key: d.key, level: lv, ...(target ? { project: target } : {}), apply: d.apply });
      ctx.log(`${d.key} ${raw === undefined ? "reset" : "set"} at ${lv}${target ? " " + target : ""} by ${caller} (${where})`);
      return effective(d, project);
    };

    // A fresh proof only for keys that loosen security; everything else is a person's plain act.
    const presence = {
      when: (/** @type {any} */ i) => { try { return declOf(String(i && i.key)).security === "loosens" && !(i && i.preview); } catch { return false; } },
      summary: (/** @type {any} */ i) => `Change ${i && i.key}`,
    };

    ctx.tool("settings.set", {
      description: "Change a setting at account level, or for one project (give project). The value is checked against the setting's type. preview: true returns what would change and writes nothing. A key that widens what Claude may do needs confirm: true; one that loosens security needs a presence proof. Returns the value now in effect.",
      input: { type: "object", required: ["key", "value"], properties: { key: str, value: {}, level: { type: "string", enum: ["account", "project"] }, project: str,
        preview: { type: "boolean" }, confirm: { type: "boolean" } } },
      callers: PEOPLE, presence,
      run: async (i, { caller }) => {
        if (i.value === null) throw Object.assign(new Error("use settings.reset to remove a value"), { code: "bad_input" });
        return change(i, caller, i.value);
      },
    });

    ctx.tool("settings.reset", {
      description: "Remove a setting's value at one level, so the level below (account, then default) applies again.",
      input: { type: "object", required: ["key"], properties: { key: str, level: { type: "string", enum: ["account", "project"] }, project: str, preview: { type: "boolean" } } },
      callers: PEOPLE, presence,
      run: async (i, { caller }) => change(i, caller, undefined),
    });

    ctx.tool("settings.resolve", {
      description: "The Vyre-owned values a session starting now in this project should use, as {key: value}. Unset keys are left out.",
      internal: true,
      input: { type: "object", properties: { project: str } },
      run: async i => {
        const project = slugOf(i.project);
        const rows = await Promise.all(decls().filter(d => !(d.store && d.store.claude)).map(d => effective(d, project)));
        return Object.fromEntries(rows.filter(r => r.value !== undefined).map(r => [r.key, r.value]));
      },
    });

    return { async stop() {} };
  },
};
