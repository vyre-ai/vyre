// @ts-check
// `vyre config`: every setting from the terminal, the same list the Deck's Settings shows
// (core/settings). list, get, set and reset; --project <slug> for a project's view or override.

import { call } from "../../daemon/client.js";
import { out, dim, bold, beacon, signal } from "../style.js";
import { json, emit, fail, usage, exitFor } from "../kit.js";

const USAGE = "vyre config [list [group]|get <key>|set <key> <value>|reset <key>] [--project <slug>] [--account] [--json]";
const APPLY = { live: "now", session: "next session", restart: "after vyre down && vyre up" };

/** Pull --project, --account and --json out of the words. @param {string[]} args */
function parse(args) {
  const o = { project: /** @type {string|null} */ (null), account: false, rest: /** @type {string[]} */ ([]) };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") o.project = args[++i] || "";
    else if (args[i] === "--account") o.account = true;
    else if (args[i] === "--json") continue;
    else o.rest.push(args[i]);
  }
  return o;
}

const show = (/** @type {any} */ v) => (v === undefined ? dim("unset") : typeof v === "string" ? v : JSON.stringify(v));
const where = (/** @type {any} */ s) => (s.source === "project" ? signal("project") : s.source === "account" ? "account" : dim(s.source));

/** @param {any} r */
const failed = r => {
  if (["unreachable", "timeout"].includes(r.error.code)) return fail("Vyre is not running", { next: "vyre up", code: r.error.code, exit: exitFor(r.error) });
  return fail(r.error.message, { code: r.error.code, exit: exitFor(r.error) });
};

/** One setting on one line. @param {any} s */
const line = s => `  ${bold(s.key)}  ${show(s.value)}  ${dim("·")} ${where(s)}${s.available === false ? beacon("  (its module is off)") : ""}${s.problem ? beacon("  " + s.problem) : ""}`;

export default {
  name: "config", order: 14, usage: USAGE, summary: "every setting, at account or project level (the Deck's Settings, in the terminal)",
  async run(/** @type {string[]} */ args) {
    const o = parse(args);
    const [verb = "list", key, ...value] = o.rest;
    const project = o.project || undefined;

    if (verb === "list") {
      const [schema, r] = await Promise.all([call("settings.schema"), call("settings.get", { ...(key ? { group: key } : {}), ...(project ? { project } : {}) })]);
      if (schema.error) return failed(schema);
      if (r.error) return failed(r);
      if (json()) return emit(r.data);
      for (const g of schema.data.groups) {
        const rows = r.data.settings.filter(s => s.group === g.id);
        if (!rows.length) continue;
        out(`\n${bold(g.label)}`);
        for (const s of rows) out(line(s));
      }
      out(dim(`\n  change one: vyre config set <key> <value>${project ? "" : " [--project <slug>]"}`));
      return 0;
    }
    if (!key) return usage(`vyre config ${verb} needs a key`, "vyre config list");

    if (verb === "get") {
      const r = await call("settings.get", { key, ...(project ? { project } : {}) });
      if (r.error) return failed(r);
      if (json()) return emit(r.data);
      const s = r.data;
      out(line(s));
      out(dim(`  ${s.label}.${s.help ? " " + s.help : ""}`));
      if (s.enum || s.choices) out(dim(`  choices: ${(s.enum || s.choices).join(", ")}`));
      if (s.account !== undefined && s.source === "project") out(dim(`  account: ${show(s.account)}`));
      if (s.default !== undefined) out(dim(`  default: ${show(s.default)}`));
      out(dim(`  set at: ${s.levels.join(", ")} · applies ${APPLY[/** @type {keyof typeof APPLY} */ (s.apply)]}${s.owner === "C" ? " · kept in Claude Code's settings files" : ""}`));
      return 0;
    }

    if (verb === "set" || verb === "reset") {
      if (verb === "set" && !value.length) return usage("vyre config set needs a value", `vyre config get ${key}`);
      const level = o.account ? "account" : project ? "project" : undefined;
      const input = { key, ...(project ? { project } : {}), ...(level ? { level } : {}) };
      const r = verb === "set" ? await call("settings.set", { ...input, value: value.join(" ") }) : await call("settings.reset", input);
      if (r.error) return failed(r);
      if (json()) return emit(r.data);
      out(line(r.data));
      out(dim(`  applies ${APPLY[/** @type {keyof typeof APPLY} */ (r.data.apply)]}`));
      return 0;
    }
    return usage(`vyre config has no ${verb}`);
  },
};
